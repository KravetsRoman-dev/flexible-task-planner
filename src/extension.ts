import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { FoundTask, Marker, Settings, scanText, validMarkers } from './scanner';

type Task = FoundTask & { uri: vscode.Uri; relativePath: string };
type Node = { type: 'group'; label: string; tasks: Task[] } | { type: 'task'; task: Task };

function loadSettings(): Settings {
  const c = vscode.workspace.getConfiguration('ftp');
  return {
    markers: validMarkers(c.get<Marker[]>('markers', [])),
    include: c.get('include', '**/*'), exclude: c.get('exclude', '**/node_modules/**'),
    commentPrefixes: c.get('commentPrefixes', ['//', '#']),
    scanAnywhere: c.get('scanAnywhere', false), caseSensitive: c.get('caseSensitive', false),
    autoRefresh: c.get('autoRefresh', true), maxFiles: c.get('maxFiles', 2000),
    maxFileKB: c.get('maxFileKB', 512), groupTasksByFile: c.get('groupTasksByFile', true)
  };
}

class TaskStore {
  private tasks: Task[] = [];
  private refreshVersion = 0;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  get all(): Task[] { return this.tasks; }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    if (!vscode.workspace.workspaceFolders?.length) {
      this.tasks = []; this.emitter.fire(); return;
    }
    const config = loadSettings();
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(config.include, config.exclude, config.maxFiles + 1);
    } catch (e) {
      vscode.window.showErrorMessage(`Task Planner: invalid file glob: ${String(e)}`);
      return;
    }
    const truncated = files.length > config.maxFiles;
    files = files.slice(0, config.maxFiles);
    const collected: Task[] = [];
    // Sequential, asynchronous reads keep memory bounded even in large workspaces.
    for (const uri of files) {
      if (version !== this.refreshVersion) { return; }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > config.maxFileKB * 1024 || bytes.includes(0)) { continue; }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const relativePath = vscode.workspace.asRelativePath(uri, true);
        for (const match of scanText(text, config)) { collected.push({ ...match, uri, relativePath }); }
      } catch { /* Missing, unreadable, or non-UTF-8 files are skipped. */ }
    }
    if (version !== this.refreshVersion) { return; }
    collected.sort((a, b) => a.priority - b.priority || a.relativePath.localeCompare(b.relativePath) || a.line - b.line);
    this.tasks = collected;
    this.emitter.fire();
    if (truncated) { void vscode.window.showWarningMessage(`Task Planner scanned only the first ${config.maxFiles} matching files. Increase maxFiles in Settings.`); }
  }
}

class TasksTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private store: TaskStore, private mode: 'tasks' | 'plan') {
    store.onDidChange(() => this.emitter.fire());
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.tasks.length}`;
      item.contextValue = 'taskGroup';
      item.iconPath = new vscode.ThemeIcon(this.mode === 'plan' ? 'list-ordered' : 'folder');
      return item;
    }
    const t = node.task;
    const item = new vscode.TreeItem(t.description, vscode.TreeItemCollapsibleState.None);
    item.description = `${t.marker} · ${t.relativePath}:${t.line + 1}`;
    item.tooltip = `${t.marker} (priority ${t.priority})\n${t.description}\n${t.relativePath}:${t.line + 1}`;
    item.iconPath = new vscode.ThemeIcon(t.priority <= 1 ? 'error' : t.priority <= 2 ? 'warning' : 'checklist');
    item.command = { command: 'ftp.open', title: 'Open Task', arguments: [t] };
    return item;
  }
  getChildren(node?: Node): Node[] {
    if (node) { return node.type === 'group' ? node.tasks.map(task => ({ type: 'task', task })) : []; }
    const tasks = this.store.all;
    if (this.mode === 'tasks' && !loadSettings().groupTasksByFile) { return tasks.map(task => ({ type: 'task', task })); }
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = this.mode === 'plan' ? `Priority ${task.priority}` : task.relativePath;
      const list = groups.get(key) ?? [];
      list.push(task);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => this.mode === 'plan' ? Number(a.split(' ')[1]) - Number(b.split(' ')[1]) : a.localeCompare(b))
      .map(([label, entries]) => ({ type: 'group', label, tasks: entries }));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

class SettingsPanel {
  private panel?: vscode.WebviewPanel;
  constructor(private store: TaskStore, private extensionUri: vscode.Uri) {}
  show(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('ftp.settings', 'Task Planner Settings', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [this.extensionUri] });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type !== 'save') { return; }
      try {
        const next = message.value;
        if (!next || typeof next !== 'object') { throw Error('Invalid settings'); }
        const markers = validMarkers(next.markers);
        if (markers.length !== next.markers?.length || !markers.length) { throw Error('Markers must have unique names (letters, digits, _ or -) and priority 1–9.'); }
        const include = String(next.include ?? '').trim();
        const exclude = String(next.exclude ?? '').trim();
        const prefixes = String(next.commentPrefixes ?? '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!include || !prefixes.length) { throw Error('Provide an include glob and at least one comment prefix.'); }
        const maxFiles = Number(next.maxFiles), maxFileKB = Number(next.maxFileKB);
        if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 20000 || !Number.isInteger(maxFileKB) || maxFileKB < 1 || maxFileKB > 10240) { throw Error('File limits are out of range.'); }
        const c = vscode.workspace.getConfiguration('ftp');
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const entries: [string, unknown][] = [
          ['markers', markers], ['include', include], ['exclude', exclude], ['commentPrefixes', prefixes],
          ['scanAnywhere', Boolean(next.scanAnywhere)], ['caseSensitive', Boolean(next.caseSensitive)],
          ['autoRefresh', Boolean(next.autoRefresh)], ['groupTasksByFile', Boolean(next.groupTasksByFile)],
          ['maxFiles', maxFiles], ['maxFileKB', maxFileKB]
        ];
        for (const [key, value] of entries) { await c.update(key, value, target); }
        await this.store.refresh();
        await panel.webview.postMessage({ type: 'saved' });
      } catch (err) { await panel.webview.postMessage({ type: 'error', message: String(err) }); }
    });
    panel.webview.html = this.html(panel.webview, loadSettings());
  }
  private html(webview: vscode.Webview, s: Settings): string {
    const nonce = randomBytes(16).toString('hex');
    const checked = (v: boolean) => v ? 'checked' : '';
    const esc = escapeHtml;
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Settings</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);padding:20px;max-width:850px;color:var(--vscode-foreground)}
h2{margin-top:27px}label{display:block;margin:12px 0 4px}input[type=text],input[type=number],textarea,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:7px;box-sizing:border-box;width:100%;font:inherit}textarea{height:110px}button{padding:8px 13px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer;margin:5px 5px 5px 0}button:hover{background:var(--vscode-button-hoverBackground)}button.danger{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.marker{display:grid;grid-template-columns:1fr 100px 85px;gap:9px;align-items:center;margin:7px 0}.marker input{margin:0}.check{display:flex;gap:8px;align-items:center}.hint{opacity:.75;font-size:.9em}.row{display:grid;grid-template-columns:1fr 1fr;gap:15px}#status{min-height:24px} </style></head>
<body><h1>Task Planner — настройки</h1><p>Правила анализа и формирования плана для текущего проекта.</p>
<h2>Маркеры и приоритеты</h2><p class="hint">Приоритет 1 — наиболее важный, 9 — наименее важный. Маркеры добавляются без изменения кода расширения.</p>
<div id="markers"></div><button type="button" id="add">+ Добавить маркер</button>
<h2>Поиск в файлах</h2><label for="include">Включаемые файлы (glob)</label><input id="include" type="text" value="${esc(s.include)}">
<label for="exclude">Исключаемые файлы (glob)</label><input id="exclude" type="text" value="${esc(s.exclude)}">
<label for="prefixes">Префиксы комментариев (один на строку)</label><textarea id="prefixes">${esc(s.commentPrefixes.join('\n'))}</textarea>
<label class="check"><input id="scanAnywhere" type="checkbox" ${checked(s.scanAnywhere)}> Искать маркеры в любом месте строки (включая код и строки)</label>
<label class="check"><input id="caseSensitive" type="checkbox" ${checked(s.caseSensitive)}> Учитывать регистр маркеров</label>
<label class="check"><input id="autoRefresh" type="checkbox" ${checked(s.autoRefresh)}> Обновлять список при изменениях сохранённых файлов</label>
<label class="check"><input id="groupTasksByFile" type="checkbox" ${checked(s.groupTasksByFile)}> Группировать задачи по файлам</label>
<div class="row"><div><label for="maxFiles">Максимум файлов</label><input id="maxFiles" type="number" min="1" max="20000" value="${s.maxFiles}"></div><div><label for="maxFileKB">Максимум КБ на файл</label><input id="maxFileKB" type="number" min="1" max="10240" value="${s.maxFileKB}"></div></div>
<p class="hint">Сканирование эвристическое: для определения комментариев ищутся заданные префиксы в строке. Это не полноценный парсер синтаксиса.</p>
<button type="button" id="save">Сохранить настройки и обновить</button><p id="status" role="status"></p>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let markers=${JSON.stringify(s.markers).replace(/</g, '\\u003c')};
const get=id=>document.getElementById(id);
function render(){const host=get('markers');host.replaceChildren();markers.forEach((marker,index)=>{const row=document.createElement('div');row.className='marker';const name=document.createElement('input');name.type='text';name.placeholder='Название';name.value=marker.name;name.addEventListener('input',()=>marker.name=name.value);const priority=document.createElement('input');priority.type='number';priority.min='1';priority.max='9';priority.value=marker.priority;priority.title='Приоритет';priority.addEventListener('input',()=>marker.priority=Number(priority.value));const del=document.createElement('button');del.className='danger';del.textContent='Удалить';del.addEventListener('click',()=>{markers.splice(index,1);render()});row.append(name,priority,del);host.append(row)})}
get('add').addEventListener('click',()=>{markers.push({name:'NEW_'+(markers.length+1),priority:3});render()});
get('save').addEventListener('click',()=>{get('status').textContent='Сохранение…';vscode.postMessage({type:'save',value:{markers,include:get('include').value,exclude:get('exclude').value,commentPrefixes:get('prefixes').value,scanAnywhere:get('scanAnywhere').checked,caseSensitive:get('caseSensitive').checked,autoRefresh:get('autoRefresh').checked,groupTasksByFile:get('groupTasksByFile').checked,maxFiles:Number(get('maxFiles').value),maxFileKB:Number(get('maxFileKB').value)}})});
window.addEventListener('message',event=>{const m=event.data;get('status').textContent=m.type==='saved'?'Настройки сохранены. План обновлён.':m.type==='error'?m.message:''});render();
</script></body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new TaskStore();
  const settingsPanel = new SettingsPanel(store, context.extensionUri);
  const taskView = vscode.window.createTreeView('ftp.tasks', { treeDataProvider: new TasksTree(store, 'tasks') });
  const planView = vscode.window.createTreeView('ftp.plan', { treeDataProvider: new TasksTree(store, 'plan') });
  const refresh = () => { void store.refresh(); };
  const showSettings = () => settingsPanel.show();
  const openTask = async (task: Task) => {
    const document = await vscode.workspace.openTextDocument(task.uri);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(task.line, task.column);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  };
  const exportPlan = async () => {
    const tasks = store.all;
    const lines = ['# Project Work Plan', '', `Tasks found: ${tasks.length}`, ''];
    let current = -1;
    for (const task of tasks) {
      if (task.priority !== current) { current = task.priority; lines.push(`## Priority ${current}`, ''); }
      lines.push(`- [ ] **${task.marker}**: ${task.description.replace(/\r?\n/g, ' ')} — \`${task.relativePath.replace(/`/g, '')}:${task.line + 1}\``);
    }
    const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, saveLabel: 'Export work plan' });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(lines.join('\n') + '\n'));
      void vscode.window.showTextDocument(uri);
    }
  };
  context.subscriptions.push(taskView, planView,
    vscode.commands.registerCommand('ftp.refresh', refresh),
    vscode.commands.registerCommand('ftp.settings', showSettings),
    vscode.commands.registerCommand('ftp.open', openTask),
    vscode.commands.registerCommand('ftp.export', exportPlan));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queueRefresh = () => {
    if (!loadSettings().autoRefresh) { return; }
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(refresh, 500);
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(queueRefresh),
    vscode.workspace.onDidCreateFiles(queueRefresh),
    vscode.workspace.onDidDeleteFiles(queueRefresh),
    vscode.workspace.onDidRenameFiles(queueRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(queueRefresh),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ftp')) { queueRefresh(); taskView.message = undefined; } }),
    { dispose: () => { if (timer) { clearTimeout(timer); } } }
  );
  void store.refresh();
}
export function deactivate(): void {}
