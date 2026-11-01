import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, props, exec, readTextFile, watchFolder, theme, settings, home } from "herdr";
// Graph view, menu and dialogs: from rabeeh-ta/herdr-git-graph (MIT, see LICENSE-git-graph.txt).
import { Graph } from "./graph.js";
import { Menu } from "./menu.js";
import { Dialog } from "./dialog.js";

// Nested git diff: the repo you're in plus every git repo below it,
// including ones the outer repo ignores or doesn't track.

// POLL_MS checks when nothing watches the folder (another machine, or the watch failed);
// with a live folder watch, a slow SAFETY_MS refresh only catches what the watch can't see.
const MAX_DEPTH = 6, MAX_REPOS = 60, MAX_FILES = 1000, RESCAN_MS = 60000, POLL_MS = 10000, SAFETY_MS = 60000;
// Big folders that are never worth walking for nested repos.
const PRUNE = ["node_modules", ".venv", "venv", "target", "dist", "build", ".next", ".nuxt", ".cache", "vendor", "Pods", ".gradle", ".terraform", "__pycache__", ".direnv"];
// Reads write nothing under .git, so the folder watch doesn't trigger itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// git runs per repo at once: unbounded, 60 repos open more pipes than the process may
// ("Too many open files"), so the per-repo work runs a few at a time, results in order.
const PARALLEL = 6;
async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// The last terminal pane focused in each tab: clicking a mod pane (this one)
// keeps showing the terminal you came from instead of the space's folder.
const lastTerminal = {};

function location() {
  const pinned = props()?.folder;
  const space = spaces().find((s) => s.active), f = focused();
  if (pinned) return { cwd: pinned, on: space?.machine ?? null };
  const all = panes();
  let pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  if (pane?.terminal && pane.cwd) lastTerminal[pane.tab] = pane.pane;
  else if (pane) {
    const inTab = all.filter((p) => p.tab === pane.tab && p.terminal && p.cwd);
    pane = inTab.find((p) => p.pane === lastTerminal[pane.tab]) ?? inTab[0] ?? pane;
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

function parseBranch(header) {
  let b = header.replace(/^## /, "").replace(/^No commits yet on /, "").replace(/^Initial commit on /, "");
  if (b.startsWith("HEAD (no branch)")) return "detached";
  return b.split("...")[0].split(" [")[0];
}

// Every folder under root holding a .git (dir, or file for worktrees/submodules).
async function findRepos(root, on) {
  const names = PRUNE.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  const r = await exec("find", [root, "-mindepth", "1", "-maxdepth", String(MAX_DEPTH),
    "(", "-type", "d", "(", ...names, ")", "-prune", ")", "-o", "-name", ".git", "-print", "-prune"], { on });
  const found = r.stdout.split("\n").filter(Boolean)
    .map((p) => p.replace(/\/\.git$/, ""))
    .filter((p) => p !== root && p.startsWith(root + "/"))
    .sort();
  return { repos: found.slice(0, MAX_REPOS), limited: found.length > MAX_REPOS };
}

export default class NestedDiff extends View {
  init(_props, cx) {
    // The graph's right-click menu and dialogs open as overlays of this mod.
    const role = props()?.role;
    if (role) { this.part = role === "menu" ? new Menu() : new Dialog(); this.part.init(cx); return; }
    this.view = "changes"; this.graph = null; this.graphRepo = null;
    this.groups = []; this.rows = []; this.diffWidth = 0; this.collapsed = new Set();
    this.refresh(cx);
    this.refreshedAt = 0;
    cx.timer.every(POLL_MS, (cx) => {
      if (this.watched && Date.now() - this.refreshedAt < SAFETY_MS) return;
      this.refresh(cx);
    });
    if (props()?.view === "graph") this.setView("graph", cx);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const paths = await watchFolder(root);
          if (this.watched !== root) break;
          // A new or removed repo: walk again.
          if (paths.some((p) => /\/\.git$/.test(p))) this.scannedAt = 0;
          // Ignore churn inside pruned folders (installs, builds).
          if (paths.length && paths.every((p) => PRUNE.some((n) => p.includes(`/${n}/`)))) continue;
          this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  reset() {
    this.base = null; this.repos = null; this.scannedAt = 0; this.groups = []; this.open = null;
    this.setLines([]); this.error = null; this.note = null; this.watched = null; this.closed = false;
    this.reposLimited = false;
  }

  refresh(cx) {
    // A change that lands mid-refresh runs one more pass after it, so it isn't lost
    // until the next watch event or timer tick.
    if (this.loading) { this.again = true; return; }
    this.again = false;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // Base: the repo you're in, or the plain folder (a folder of repos).
        if (!this.base) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (key() !== context) return;
          const isRepo = top.code === 0;
          const base = isRepo ? top.stdout.trim() : cwd.replace(/\/$/, "");
          if (!isRepo && !on && base === home()) { this.error = "Open a project folder (home is too big to scan)"; return; }
          this.base = base; this.baseIsRepo = isRepo; this.on = on;
        }
        const base = this.base;
        if (!this.repos || Date.now() - this.scannedAt > RESCAN_MS) {
          const { repos: nested, limited } = await findRepos(base, on);
          if (key() !== context) return;
          this.reposLimited = limited;
          const all = [...(this.baseIsRepo ? [base] : []), ...nested];
          // Which repo contains each one, and does it ignore it?
          const repos = await mapLimit(all, async (root) => {
            const parent = all.filter((r) => r !== root && root.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];
            let ignored = false;
            if (parent) {
              const rel = root.slice(parent.length + 1);
              ignored = (await exec("git", [...READ, "check-ignore", "-q", rel], { cwd: parent, on })).code === 0;
            }
            return { root, rel: root === base ? "" : root.slice(base.length + 1), ignored };
          });
          if (key() !== context) return;
          this.repos = repos; this.scannedAt = Date.now();
        }
        if (!this.repos.length) { this.groups = []; this.error = "No git repositories here"; return; }

        const groups = await mapLimit(this.repos, (repo) => this.readRepo(repo));
        if (key() !== context) return;
        this.groups = groups; this.error = null;
        this.watch(base, cx);
        const files = groups.flatMap((g) => g.files);
        if (this.open && !files.some((f) => f.id === this.open)) { this.open = null; this.setLines([]); }
        if (!this.open && !this.closed && files.length) this.open = files[0].id;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; this.refreshedAt = Date.now();
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async readRepo(repo) {
    const { root } = repo, on = this.on, git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const group = { ...repo, branch: "", files: [], add: 0, del: 0, error: null, limited: false };
    try {
      const status = await git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]);
      if (status.code !== 0) throw new Error(status.stderr.trim());
      const head = await git(["rev-parse", "--verify", "HEAD"]);
      group.hasHead = head.code === 0;
      const stats = {};
      const results = group.hasHead
        ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
        : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
      for (const result of results) {
        if (result.code !== 0) throw new Error(result.stderr.trim());
        for (const entry of result.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
          stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
        }
      }
      // Child repos show in this one as `?? sub/` or a submodule entry: they get their own group.
      const children = new Set((this.repos ?? []).filter((r) => r.root.startsWith(root + "/")).map((r) => r.root.slice(root.length + 1)));
      let entries = status.stdout.split("\0").filter(Boolean);
      if (entries[0]?.startsWith("## ")) group.branch = parseBranch(entries.shift());
      entries = entries.filter((e) => !children.has(e.slice(3).replace(/\/$/, "")));
      group.limited = entries.length > MAX_FILES;
      for (const entry of entries.slice(0, MAX_FILES)) {
        const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
        const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
        const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
        const stat = stats[path] ?? { add: 0, del: 0 };
        group.files.push({ id: `${repo.rel}\0${path}`, repo: group, path, status: s, fresh, ...stat });
      }
      group.add = group.files.reduce((n, f) => n + f.add, 0);
      group.del = group.files.reduce((n, f) => n + f.del, 0);
    } catch (e) { group.error = String(e.message || e); }
    return group;
  }

  find(id) { for (const g of this.groups) for (const f of g.files) if (f.id === id) return f; return null; }

  async load(id, context) {
    const file = this.find(id), on = this.on;
    if (!file) return;
    const { root, hasHead } = file.repo;
    let lines;
    if (file.fresh || (!hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === id) this.setLines(lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
  }

  pick(id, cx) {
    this.open = this.open === id ? null : id; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(id, context); }
      catch (e) { if (key() === context && this.open === id) this.note = `Cannot preview this diff: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  toggle(rel, cx) {
    if (this.collapsed.has(rel)) this.collapsed.delete(rel); else this.collapsed.add(rel);
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  groupHeader(g, t) {
    const name = g.rel || (this.base ?? "").split("/").pop() || "/";
    const folded = this.collapsed.has(g.rel);
    return h_flex().id(`repo-${g.rel || "."}`).h(28).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(g.rel, cx))
      .child(div().w(10).text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().min_w(0).truncate().font_semibold().child(name))
      .when(g.ignored, (e) => e.child(div().px(4).rounded(4).border_1().border_color(t.border).text_size(9).text_color(t.muted).child("ignored")))
      .when(Boolean(g.branch), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(g.branch)))
      .child(div().flex_1())
      .when(Boolean(g.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child("error")))
      .child(div().text_size(10).text_color(t.muted).child(String(g.files.length)))
      .when(g.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${g.add}`)))
      .when(g.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${g.del}`)));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`file-${f.id}`).h(26).flex_none().pl(22).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.id, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.id, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // The repo the graph shows: the one picked, else the base repo, else the first nested one.
  graphTarget() {
    const roots = (this.repos ?? []).map((r) => r.root);
    if (this.graphRepo && roots.includes(this.graphRepo)) return this.graphRepo;
    return this.baseIsRepo ? this.base : roots[0] ?? null;
  }

  setView(view, cx) {
    this.view = view;
    if (view === "graph" && !this.graph) {
      this.graph = new Graph();
      this.graph.folder = this.graphTarget(); this.graph.machine = this.on ?? null;
      this.graph.init(cx);
    }
    cx.notify();
  }

  switcher(t) {
    const tab = (id, text, on) => div().id(id).h(22).px(9).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
      .bg(on ? t.raised : t.background).text_color(on ? t.foreground : t.muted).when(on, (e) => e.border_1().border_color(t.border))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setView(id === "nd-tab-graph" ? "graph" : "changes", cx)).child(text);
    return h_flex().p(2).gap(2).flex_none().rounded(7).bg(t.background).border_1().border_color(t.border)
      .child(tab("nd-tab-changes", "Changes", this.view !== "graph"))
      .child(tab("nd-tab-graph", "Graph", this.view === "graph"));
  }

  repoChips(t, target) {
    const repos = this.repos ?? [];
    if (repos.length < 2) return null;
    return h_flex().id("nd-repo-chips").flex_none().px(10).py(6).gap(4).flex_wrap().border_b(1).border_color(t.border)
      .children(repos.map((r) => {
        const on = r.root === target, name = r.rel || (this.base ?? "").split("/").pop() || "/";
        return div().id(`nd-repo-${r.rel || "."}`).h(22).px(8).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
          .when(on, (e) => e.bg(t.accent + "26").text_color(t.accent).font_semibold())
          .when(!on, (e) => e.text_color(t.muted).border_1().border_color(t.border))
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.graphRepo = r.root; cx.notify(); })
          .child(name);
      }));
  }

  renderGraph(cx, t) {
    const target = this.graphTarget();
    const root = v_flex().id("nested-diff").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).child(this.switcher(t)));
    if (!target) return root.child(div().p(14).text_color(t.dim)
      .child(this.error || (this.loading ? "Scanning repositories…" : "No git repositories here")));
    // Graph reloads by itself when its folder changes.
    this.graph.folder = target; this.graph.machine = this.on ?? null;
    const chips = this.repoChips(t, target);
    return root.when(Boolean(chips), (e) => e.child(chips))
      .child(div().flex_1().min_h(0).child(this.graph.render(cx)));
  }

  render(cx) {
    if (this.part) return this.part.render(cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    if (this.view === "graph") return this.renderGraph(cx, t);
    const dirty = this.groups.filter((g) => g.files.length || g.error), clean = this.groups.length - dirty.length;
    const files = dirty.reduce((n, g) => n + g.files.length, 0);
    const add = dirty.reduce((n, g) => n + g.add, 0), del = dirty.reduce((n, g) => n + g.del, 0);
    const listRows = [];
    for (const g of dirty) {
      listRows.push(this.groupHeader(g, t));
      if (this.collapsed.has(g.rel)) continue;
      if (g.error) listRows.push(div().pl(22).py(2).text_size(11).text_color(t.ansi1).truncate().child(g.error));
      for (const f of g.files) listRows.push(this.fileRow(f, t));
      if (g.limited) listRows.push(div().pl(22).py(2).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_FILES} files`));
    }
    const listHeight = Math.min(300, Math.max(44, listRows.length * 27 + 12));

    // Herdr's pane header already shows the title; this bar is just the summary.
    return v_flex().id("nested-diff").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.switcher(t))
        .child(div().text_size(11).text_color(t.muted)
          .child(`${this.groups.length} repos · ${files} files`))
        .child(div().flex_1())
        .when(this.loading, (e) => e.child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
        .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().id("nested-list").flex_none().h(listHeight).overflow_y_scrollbar().p(6).gap(1).border_b(1).border_color(t.border)
        .children(listRows)
        .when(!listRows.length, (e) => e.child(div().p(8).text_color(t.dim)
          .child(this.error || (this.loading && !this.groups.length ? "Scanning repositories…" : this.base ? "No uncommitted changes" : "No folder")))))
      .when(Boolean(this.reposLimited), (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.dim).border_b(1).border_color(t.border).child(`Showing the first ${MAX_REPOS} nested repos`)))
      .when(clean > 0 && dirty.length > 0, (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.dim).border_b(1).border_color(t.border).child(`${clean} clean ${clean === 1 ? "repo" : "repos"} hidden`)))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("nested-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("nested-diff-rows", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("nested-diff-rows").viewport_from_layout().absolute().inset_0())
        .when(!this.open && files > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
