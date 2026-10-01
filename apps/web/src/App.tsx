import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor, languages as MonacoLanguages, Range as MonacoRange } from 'monaco-editor';
import {
  Activity, Braces, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, FileCode2,
  FilePlus2, Folder, Gauge, GitBranch, Layers3, Maximize2, MoreHorizontal, PanelLeftClose, Pencil,
  Moon, Play, Plus, Search, Settings2, Square, Sun, TerminalSquare, Trash2, TriangleAlert,
  Workflow, X,
} from 'lucide-react';

type Runtime = { available: boolean; language: string; version?: string; vendor?: string; mode?: 'docker' | 'local' | 'vercel-sandbox'; sandboxed?: boolean; message?: string };
type Diagnostic = { file: string; line: number; column?: number | null; severity: string; code: string; message: string };
type RunResult = { status: string; output: string; exit_code: number | null; elapsed_ms: number; memory_mb?: number | null; diagnostics: Diagnostic[] };
type Job = { id: string; status: string; result?: RunResult; error?: string };
type Theme = 'dark' | 'light';

const legacyStarter = [
  'import java.util.*;',
  '',
  'public class Main {',
  '    public static void main(String[] args) {',
  '        Scanner input = new Scanner(System.in);',
  '        String name = input.hasNextLine() ? input.nextLine() : "CodeLab";',
  '        System.out.println("Hello, " + name + "!");',
  '    }',
  '}',
].join('\n');
const starter = [
  'import java.util.Scanner;',
  '',
  'public class Main {',
  '    public static void main(String[] args) {',
  '        Scanner input = new Scanner(System.in);',
  '        String name = "Shankar";',
  '        if (input.hasNextLine()) {',
  '            String typedName = input.nextLine().trim();',
  '            if (!typedName.isEmpty()) name = typedName;',
  '        }',
  '        System.out.println("Hey, " + name + "! Welcome to ASRVOne CodeLab.");',
  '    }',
  '}',
].join('\n');
const initialFiles = { 'Main.java': starter };
const terminalTabs = ['Output', 'Input', 'Problems'] as const;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
const runShortcut = isMacPlatform ? 'Cmd + Enter' : 'Ctrl + Enter';
type WorkspaceEntry = { path: string; type: 'file' | 'folder'; depth: number };
type ResizeTarget = 'explorer' | 'inspector' | 'terminal';

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function loadSavedFolders(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('codelab.folders') ?? '[]') as unknown;
    if (Array.isArray(saved) && saved.every((path) => typeof path === 'string')) return saved;
  } catch { /* use the starter project */ }
  return [];
}

function loadProjectName(): string {
  return localStorage.getItem('codelab.projectName')?.trim() || 'CodeLab';
}

function buildWorkspaceEntries(files: Record<string, string>, explicitFolders: string[], collapsed: Set<string>, filter: string): WorkspaceEntry[] {
  const filePaths = Object.keys(files);
  const folders = new Set(explicitFolders);
  for (const file of filePaths) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'));
  }
  const query = filter.trim().toLowerCase();
  const entries: WorkspaceEntry[] = [];
  const visit = (parent: string, depth: number) => {
    const childFolders = [...folders].filter((path) => parentPath(path) === parent).sort();
    const childFiles = filePaths.filter((path) => parentPath(path) === parent).sort();
    for (const path of childFolders) {
      const hasMatch = !query || path.toLowerCase().includes(query) || filePaths.some((file) => file.startsWith(`${path}/`) && file.toLowerCase().includes(query));
      if (!hasMatch) continue;
      entries.push({ path, type: 'folder', depth });
      if (!collapsed.has(path)) visit(path, depth + 1);
    }
    for (const path of childFiles) {
      if (!query || path.toLowerCase().includes(query)) entries.push({ path, type: 'file', depth });
    }
  };
  visit('', 0);
  return entries;
}

function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

function hasMainMethod(source: string): boolean {
  return /\bstatic\b[^;{}]{0,80}?\bvoid\s+main\s*\(\s*(?:final\s+)?(?:(?:java\.lang\.)?String\s*(?:\[\s*\]|\.\.\.)\s*\w*|(?:java\.lang\.)?String\s+\w+\s*\[\s*\])\s*\)/.test(source);
}

function findEntryPoint(files: Record<string, string>, activeFile: string): string {
  const paths = Object.keys(files);
  if (files[activeFile] && hasMainMethod(files[activeFile])) return activeFile;
  const namedMain = paths.find((path) => path.replaceAll('\\', '/').split('/').at(-1) === 'Main.java' && hasMainMethod(files[path]));
  return namedMain ?? paths.find((path) => hasMainMethod(files[path])) ?? activeFile ?? paths[0] ?? 'Main.java';
}

function loadSavedFiles(): Record<string, string> {
  try {
    const saved = localStorage.getItem('codelab.files');
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, string>;
      if (parsed['Main.java'] === legacyStarter) return { ...parsed, 'Main.java': starter };
      return parsed;
    }
  } catch { /* use the starter project */ }
  return initialFiles;
}

function loadSavedStdin(): string {
  const saved = localStorage.getItem('codelab.stdin');
  if (!saved) return 'Shankar';
  try {
    const files = JSON.parse(localStorage.getItem('codelab.files') ?? '{}') as Record<string, string>;
    if (saved === 'World' && files['Main.java'] === legacyStarter) return 'Shankar';
  } catch { /* keep the saved input */ }
  return saved;
}

function App() {
  const [files, setFiles] = useState<Record<string, string>>(loadSavedFiles);
  const [folders, setFolders] = useState<string[]>(loadSavedFolders);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [activeFile, setActiveFile] = useState('Main.java');
  const [activeTerminal, setActiveTerminal] = useState<(typeof terminalTabs)[number]>('Output');
  const [projectName, setProjectName] = useState(loadProjectName);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName);
  const [projectNameError, setProjectNameError] = useState('');
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [stdin, setStdin] = useState(loadSavedStdin);
  const [runtime, setRuntime] = useState<Runtime>({ available: false, language: 'Java', message: 'Checking runtime' });
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('codelab.theme') === 'light' ? 'light' : 'dark');
  const [showSearch, setShowSearch] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pathDialog, setPathDialog] = useState<{ kind: 'folder' | 'file' | 'rename-folder'; path: string; value: string } | null>(null);
  const [pathError, setPathError] = useState('');
  const [deleteFolderPath, setDeleteFolderPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [explorerWidth, setExplorerWidth] = useState(() => Number(localStorage.getItem('codelab.explorerWidth')) || 208);
  const [inspectorWidth, setInspectorWidth] = useState(() => Number(localStorage.getItem('codelab.inspectorWidth')) || 240);
  const [terminalHeight, setTerminalHeight] = useState(() => Number(localStorage.getItem('codelab.terminalHeight')) || 254);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const resizeRef = useRef<{ target: ResizeTarget; coordinate: number; initial: number } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const runCodeRef = useRef<() => Promise<void>>(async () => undefined);
  const isRunning = busy && (job?.status === 'QUEUED' || job?.status === 'RUNNING' || job === null);
  const source = files[activeFile] ?? '';
  const entryPointPath = findEntryPoint(files, activeFile);
  const entryPointName = entryPointPath.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.java$/, '') ?? 'Main';
  const result = job?.result;
  const diagnostics = result?.diagnostics ?? [];
  const workspaceEntries = buildWorkspaceEntries(files, folders, collapsedFolders, filter);
  const startResize = (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) => {
    const initial = target === 'explorer' ? explorerWidth : target === 'inspector' ? inspectorWidth : terminalHeight;
    resizeRef.current = { target, coordinate: target === 'terminal' ? event.clientY : event.clientX, initial };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    const coordinate = resize.target === 'terminal' ? event.clientY : event.clientX;
    const delta = coordinate - resize.coordinate;
    if (resize.target === 'explorer') setExplorerWidth(Math.max(150, Math.min(420, resize.initial + delta)));
    if (resize.target === 'inspector') setInspectorWidth(Math.max(190, Math.min(420, resize.initial - delta)));
    if (resize.target === 'terminal') setTerminalHeight(Math.max(150, Math.min(window.innerHeight * 0.65, resize.initial - delta)));
  };
  const stopResize = () => { resizeRef.current = null; };
  const resizeHandle = (target: ResizeTarget) => ({
    role: 'separator' as const,
    tabIndex: 0,
    'aria-label': `Resize ${target} panel`,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => startResize(target, event),
    onPointerMove: moveResize,
    onPointerUp: stopResize,
    onPointerCancel: stopResize,
  });
  const terminalContent = useMemo(() => {
    if (activeTerminal === 'Input') return null;
    if (activeTerminal === 'Problems') return diagnostics;
    return result?.output ?? (job?.error ? `Runner unavailable\n\n${job.error}` : 'Run your Java program to see the output here.');
  }, [activeTerminal, diagnostics, job, result]);

  useEffect(() => { localStorage.setItem('codelab.files', JSON.stringify(files)); }, [files]);
  useEffect(() => { localStorage.setItem('codelab.projectName', projectName); }, [projectName]);
  useEffect(() => { localStorage.setItem('codelab.folders', JSON.stringify(folders)); }, [folders]);
  useEffect(() => { localStorage.setItem('codelab.explorerWidth', String(explorerWidth)); }, [explorerWidth]);
  useEffect(() => { localStorage.setItem('codelab.inspectorWidth', String(inspectorWidth)); }, [inspectorWidth]);
  useEffect(() => { localStorage.setItem('codelab.terminalHeight', String(terminalHeight)); }, [terminalHeight]);
  useEffect(() => { if (!pathDialog) setPathError(''); }, [pathDialog]);
  useEffect(() => { localStorage.setItem('codelab.stdin', stdin); }, [stdin]);
  useEffect(() => { localStorage.setItem('codelab.theme', theme); }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const checkRuntime = async () => {
      try {
        const response = await fetch(apiUrl('/runtime'));
        if (!response.ok) throw new Error('API offline');
        const value = await response.json() as Runtime;
        if (!cancelled) setRuntime(value);
      } catch {
        if (!cancelled) setRuntime({ available: false, language: 'Java', message: 'API offline' });
      }
    };
    void checkRuntime();
    const timer = window.setInterval(() => { if (!runtime.available) void checkRuntime(); }, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runtime.available]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !editorRef.current) return;
    const markers = diagnostics.filter((item) => item.file === activeFile).map((item) => ({
      severity: item.severity === 'warning' ? 4 : 8,
      message: item.message,
      startLineNumber: item.line,
      startColumn: item.column ?? 1,
      endLineNumber: item.line,
      endColumn: (item.column ?? 1) + 1,
      source: 'javac',
    }));
    if (monacoRef.current) monacoRef.current.editor.setModelMarkers(model, 'codelab', markers);
  }, [activeFile, diagnostics]);

  const mountEditor: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme('codelab-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: { 'editor.background': '#101216', 'editorLineNumber.foreground': '#4f5560', 'editorLineNumber.activeForeground': '#aeb7c5', 'editor.selectionBackground': '#474e5b70', 'editorCursor.foreground': '#a7f3c3' },
    });
    monaco.editor.defineTheme('codelab-light', {
      base: 'vs', inherit: true, rules: [],
      colors: { 'editor.background': '#f8fafc', 'editorLineNumber.foreground': '#a0a8b4', 'editorLineNumber.activeForeground': '#4b5563', 'editor.selectionBackground': '#c9ddf488', 'editorCursor.foreground': '#16834a', 'editorLineHighlightBackground': '#eef2f7' },
    });
    monaco.editor.setTheme(theme === 'light' ? 'codelab-light' : 'codelab-dark');
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void runCodeRef.current(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { localStorage.setItem('codelab.files', JSON.stringify(files)); });
    const codeActionProvider: Parameters<typeof monaco.languages.registerCodeActionProvider>[1] = {
      provideCodeActions(model: MonacoEditor.ITextModel, _range: MonacoRange, context: MonacoLanguages.CodeActionContext) {
        const actions = context.markers.flatMap((marker) => {
          if (marker.message !== "';' expected") return [];
          const line = marker.startLineNumber;
          const column = Math.min(marker.startColumn, model.getLineMaxColumn(line));
          return [{
            title: 'Add missing semicolon',
            kind: monaco.languages.CodeActionKind.QuickFix,
            diagnostics: [marker],
            isPreferred: true,
            edit: {
              edits: [{
                resource: model.uri,
                textEdit: { range: new monaco.Range(line, column, line, column), text: ';' },
              }],
            },
          }];
        });
        return { actions, dispose() {} };
      },
    };
    monaco.languages.registerCodeActionProvider('java', codeActionProvider);
  };

  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === 'light' ? 'codelab-light' : 'codelab-dark');
  }, [theme]);

  useEffect(() => {
    if (!aboutOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAboutOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [aboutOpen]);

  const updateSource = (value?: string) => {
    setFiles((current) => ({ ...current, [activeFile]: value ?? '' }));
    setJob(null);
  };

  const runCode = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActiveTerminal('Output');
    setJob({ id: '', status: 'QUEUED' });
    try {
      const mainPath = findEntryPoint(files, activeFile);
      const mainName = mainPath.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.java$/, '') ?? 'Main';
      const packageName = files[mainPath]?.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      const started = await fetch(apiUrl('/run'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, stdin, main_class: packageName ? `${packageName}.${mainName}` : mainName, timeout_seconds: 15 }),
      });
      if (!started.ok) {
        const error = await started.json().catch(() => ({}));
        throw new Error(error.detail ?? 'CodeLab API is offline. Start the complete local stack with `npm run dev`.');
      }
      const first = await started.json() as Job;
      if (first.result && !['QUEUED', 'RUNNING'].includes(first.status)) {
        setJob(first);
        return;
      }
      const { id } = first;
      setJob({ id, status: 'QUEUED' });
      let terminal = false;
      while (!terminal) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const response = await fetch(apiUrl(`/jobs/${id}`));
        if (!response.ok) throw new Error('Could not read the execution result.');
        const next = await response.json() as Job;
        setJob(next);
        terminal = !['QUEUED', 'RUNNING'].includes(next.status);
      }
    } catch (error) {
      setJob({ id: '', status: 'ERROR', error: error instanceof Error ? error.message : 'Unexpected execution error.' });
    } finally {
      setBusy(false);
    }
  }, [activeFile, busy, files, stdin]);
  runCodeRef.current = runCode;

  const stopCode = async () => {
    if (!job?.id) return;
    await fetch(apiUrl(`/jobs/${job.id}/stop`), { method: 'POST' }).catch(() => undefined);
  };

  const addFile = (folder = '') => {
    let path = `${folder ? `${folder}/` : ''}Solution.java`;
    let index = 2;
    while (files[path]) path = `${folder ? `${folder}/` : ''}Solution${index++}.java`;
    const className = path.split('/').at(-1)?.replace(/\.java$/, '') ?? 'Solution';
    setFiles((current) => ({ ...current, [path]: `public class ${className} {\n    public static void main(String[] args) {\n        // Start writing here\n    }\n}\n` }));
    setActiveFile(path);
  };

  const addFolder = () => {
    setPathError('');
    setPathDialog({ kind: 'folder', path: '', value: 'src' });
  };

  const submitPathDialog = () => {
    if (!pathDialog) return;
    const { kind, path } = pathDialog;
    const normalized = pathDialog.value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
      setPathError('Use a valid relative path without . or .. segments.');
      return;
    }
    if (kind === 'folder') {
      const filePaths = Object.keys(files);
      if ([...folders, ...filePaths].some((item) => item === normalized || item.startsWith(`${normalized}/`)) || filePaths.some((file) => normalized.startsWith(`${file}/`))) {
        setPathError('That path conflicts with an existing file or folder.');
        return;
      }
      setFolders((current) => [...new Set([...current, ...normalized.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))])]);
    } else if (kind === 'file') {
      if (normalized === path) {
        setPathDialog(null);
        setPathError('');
        return;
      }
      const fileCollision = files[normalized] || folders.some((folder) => folder === normalized || folder.startsWith(`${normalized}/`)) || Object.keys(files).some((file) => file.startsWith(`${normalized}/`) || normalized.startsWith(`${file}/`));
      if (!normalized.endsWith('.java') || fileCollision) {
        setPathError('Choose a unique relative Java file path.');
        return;
      }
      const oldClassName = path.split('/').at(-1)?.replace(/\.java$/, '') ?? '';
      const newClassName = normalized.split('/').at(-1)?.replace(/\.java$/, '') ?? '';
      const renamedContent = /^[A-Za-z_$][\w$]*$/.test(oldClassName) && /^[A-Za-z_$][\w$]*$/.test(newClassName)
        ? files[path].replace(new RegExp(`(\\bpublic\\s+)?(class|interface|enum|record)\\s+${oldClassName}\\b`), (_match, visibility = '', type) => `${visibility}${type} ${newClassName}`)
        : files[path];
      setFiles((current) => {
        const updated = { ...current, [normalized]: renamedContent };
        delete updated[path];
        return updated;
      });
      if (activeFile === path) setActiveFile(normalized);
    } else {
      if (normalized === path) {
        setPathDialog(null);
        setPathError('');
        return;
      }
      const pathItems = [...folders, ...Object.keys(files)];
      const targetIsSourceDescendant = normalized.startsWith(`${path}/`);
      const destinationExists = pathItems.some((item) => !item.startsWith(`${path}/`) && (item === normalized || item.startsWith(`${normalized}/`)));
      const targetIsInsideFile = Object.keys(files).some((file) => normalized.startsWith(`${file}/`));
      if (targetIsSourceDescendant || destinationExists || targetIsInsideFile) {
        setPathError('Choose a folder path that does not overlap an existing file or folder.');
        return;
      }
      const renamedFiles = Object.fromEntries(Object.entries(files).map(([file, content]) => [file === path || file.startsWith(`${path}/`) ? `${normalized}${file.slice(path.length)}` : file, content]));
      setFiles(renamedFiles);
      setFolders((current) => {
        const renamedFolders = current.map((folder) => folder === path || folder.startsWith(`${path}/`) ? `${normalized}${folder.slice(path.length)}` : folder);
        const withAncestors = new Set(renamedFolders);
        for (const folder of renamedFolders) {
          const parts = folder.split('/');
          for (let index = 1; index < parts.length; index += 1) withAncestors.add(parts.slice(0, index).join('/'));
        }
        return [...withAncestors];
      });
      setCollapsedFolders((current) => new Set([...current].map((folder) => folder === path || folder.startsWith(`${path}/`) ? `${normalized}${folder.slice(path.length)}` : folder)));
      if (activeFile === path || activeFile.startsWith(`${path}/`)) setActiveFile(`${normalized}${activeFile.slice(path.length)}`);
    }
    setPathDialog(null);
    setPathError('');
  };

  const renameFile = (path: string) => {
    setPathError('');
    setPathDialog({ kind: 'file', path, value: path });
  };

  const renameFolder = (path: string) => {
    setPathError('');
    setPathDialog({ kind: 'rename-folder', path, value: path });
  };

  const deleteFolder = (path: string) => {
    setDeleteFolderPath(path);
  };

  const confirmDeleteFolder = () => {
    if (!deleteFolderPath) return;
    const path = deleteFolderPath;
    const remainingFiles = Object.fromEntries(Object.entries(files).filter(([file]) => file !== path && !file.startsWith(`${path}/`)));
    setFiles(remainingFiles);
    setFolders((current) => current.filter((folder) => folder !== path && !folder.startsWith(`${path}/`)));
    setCollapsedFolders((current) => new Set([...current].filter((folder) => folder !== path && !folder.startsWith(`${path}/`))));
    if (activeFile === path || activeFile.startsWith(`${path}/`)) setActiveFile(Object.keys(remainingFiles)[0] ?? '');
    setDeleteFolderPath(null);
  };

  const deleteFile = (name: string) => {
    if (Object.keys(files).length < 2) return;
    const remainingFiles = Object.fromEntries(Object.entries(files).filter(([key]) => key !== name));
    setFiles(remainingFiles);
    if (activeFile === name) setActiveFile(Object.keys(remainingFiles)[0] ?? '');
  };

  const openProjectNameDialog = () => {
    setProjectNameDraft(projectName);
    setProjectNameError('');
    setProjectDialogOpen(true);
  };

  const saveProjectName = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectNameDraft.trim().replace(/\s+/g, ' ');
    if (!name) {
      setProjectNameError('Project name cannot be empty.');
      return;
    }
    if (name.length > 48) {
      setProjectNameError('Project name must be 48 characters or fewer.');
      return;
    }
    setProjectName(name);
    setProjectDialogOpen(false);
  };

  const statusTone = result?.status === 'SUCCESS' ? 'good' : ['COMPILE_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED'].includes(result?.status ?? '') ? 'bad' : 'neutral';
  const filteredFiles = Object.keys(files).filter((name) => name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main className={`app-shell theme-${theme}`} style={{ '--terminal-height': terminalCollapsed ? '0px' : `${terminalHeight}px` } as CSSProperties}>
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Code2 size={18} strokeWidth={2.4} /></div><div><div className="brand-name">codelab<span>.</span></div><div className="brand-caption">JAVA WORKSPACE</div></div></div>
        <div className="workspace-crumb"><Folder size={14} /><span>My workspace</span><ChevronRight size={13} /><button className="project-name-button" onClick={openProjectNameDialog} title="Rename project"><strong>{projectName}</strong><Pencil size={12} /></button><ChevronDown size={13} /></div>
        <div className="top-actions"><span className={`save-state ${busy ? 'saving' : ''}`}><span className="save-dot" />{busy ? 'Running' : 'Saved locally'}</span><button className="icon-button theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button help-button" onClick={() => setAboutOpen(true)} title="About CodeLab" aria-label="About CodeLab"><CircleHelp size={17} /></button><button className="avatar" title="Local workspace">S</button></div>
      </header>

      <div className="actionbar">
        <div className="action-left"><div className="language-pill"><span className="java-glyph">J</span><span>Java</span><ChevronDown size={13} /></div><span className="divider" /><button className="bar-button" onClick={() => setCollapsed((value) => !value)} title="Toggle explorer"><PanelLeftClose size={16} /><span>Explorer</span></button><button className="bar-button" onClick={() => setShowSearch((value) => !value)} title="Search files"><Search size={16} /><span>Search</span></button></div>
        <div className="action-right"><span className={`runtime-chip ${runtime.available ? 'online' : ''}`}><span className="runtime-dot" />{runtime.available ? `${runtime.sandboxed ? runtime.mode === 'vercel-sandbox' ? 'Vercel Sandbox' : 'Sandbox' : 'Local'} · ${runtime.vendor} ${runtime.version}` : runtime.message ?? 'Java runner offline'}</span><button className="bar-button output-toggle" onClick={() => setTerminalCollapsed((value) => !value)} aria-expanded={!terminalCollapsed} title={terminalCollapsed ? 'Show output panel' : 'Hide output panel'}><TerminalSquare size={16} /><span>Output</span></button><button className="bar-button settings-button" title="Settings"><Settings2 size={16} /></button><button className="run-button" onClick={() => void runCode()} disabled={busy}><Play size={15} fill="currentColor" />{busy ? 'Running' : 'Run'}<kbd>{isMacPlatform ? '⌘ ↵' : 'Ctrl ↵'}</kbd></button>{busy && job?.id && <button className="stop-button" onClick={() => void stopCode()} title="Stop execution"><Square size={14} fill="currentColor" /></button>}</div>
      </div>

      <section className={`workbench ${collapsed ? 'explorer-collapsed' : ''}`} style={{ gridTemplateColumns: collapsed ? `minmax(300px,1fr) 6px ${inspectorWidth}px` : `${explorerWidth}px 6px minmax(300px,1fr) 6px ${inspectorWidth}px` }}>
        {!collapsed && <aside className="explorer panel">
          <div className="panel-heading"><div className="panel-label"><ChevronDown size={13} /><span>EXPLORER</span></div><div className="heading-actions"><button className="mini-icon" onClick={() => addFile()} title="New Java file"><FilePlus2 size={15} /></button><button className="mini-icon" onClick={addFolder} title="New folder"><Folder size={15} /></button></div></div>
          <div className="project-label"><ChevronDown size={13} /><button className="project-label-name" onClick={openProjectNameDialog} title="Rename project">{projectName.toUpperCase()}</button><button className="mini-icon" onClick={() => addFile()} title="Add file"><Plus size={14} /></button></div>
          {showSearch && <div className="search-field"><Search size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" autoFocus /><button className="mini-icon" onClick={() => { setShowSearch(false); setFilter(''); }}><X size={13} /></button></div>}
          <div className="file-list">{workspaceEntries.map(({ path, type, depth }) => <div key={`${type}:${path}`} className={`file-row ${path === activeFile && type === 'file' ? 'selected' : ''}`} style={{ paddingLeft: `${depth * 12}px` }}>{type === 'folder' ? <><button className="file-select folder-select" onClick={() => setCollapsedFolders((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; })}><ChevronRight className={collapsedFolders.has(path) ? '' : 'folder-expanded'} size={13} /><Folder size={14} /><span>{path.split('/').at(-1)}</span></button><button className="mini-icon file-action" onClick={() => addFile(path)} title="New Java file in folder"><FilePlus2 size={13} /></button><button className="mini-icon file-action" onClick={() => renameFolder(path)} title="Rename folder"><MoreHorizontal size={14} /></button><button className="mini-icon file-action" onClick={() => deleteFolder(path)} title="Delete folder"><Trash2 size={13} /></button></> : <><button className="file-select" onClick={() => setActiveFile(path)}><FileCode2 size={15} /><span>{path.split('/').at(-1)}</span></button><button className="mini-icon file-action" onClick={() => renameFile(path)} title="Rename file"><MoreHorizontal size={14} /></button>{Object.keys(files).length > 1 && <button className="mini-icon file-delete" onClick={() => deleteFile(path)} title="Delete file"><Trash2 size={13} /></button>}</>}</div>)}</div>
          <div className="explorer-bottom"><div className="project-meta"><Layers3 size={14} /><span>{Object.keys(files).length} {Object.keys(files).length === 1 ? 'file' : 'files'}</span></div><span className="project-lang">Java</span></div>
        </aside>}
        {!collapsed && <div className="panel-resizer vertical" {...resizeHandle('explorer')} />}

        <section className="editor-column panel">
          <div className="editor-tabs"><div className="active-tab"><span className="java-glyph small">J</span><span>{activeFile}</span><span className="tab-unsaved" /></div><div className="tab-spacer" /><button className="mini-icon editor-tool" title="Split editor"><Workflow size={15} /></button><button className="mini-icon editor-tool" title="More editor actions"><MoreHorizontal size={16} /></button></div>
          <div className="breadcrumb"><span>src</span><ChevronRight size={12} /><span>{activeFile}</span><span className="breadcrumb-spacer" /><span className="code-lens">Java</span></div>
          <div className="editor-wrap"><Editor height="100%" language="java" path={activeFile} value={source} onChange={updateSource} onMount={mountEditor} theme={theme === 'light' ? 'codelab-light' : 'codelab-dark'} options={{ automaticLayout: true, fontSize: 14, fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace', lineHeight: 23, minimap: { enabled: true, scale: 0.75 }, scrollBeyondLastLine: false, tabSize: 4, insertSpaces: true, bracketPairColorization: { enabled: true }, guides: { indentation: true }, padding: { top: 14, bottom: 18 }, wordWrap: 'off', renderLineHighlight: 'all', smoothScrolling: true, cursorBlinking: 'smooth', glyphMargin: true }} /></div>
          <div className="statusbar"><div className="status-left"><span><GitBranch size={13} /> main</span><span><Activity size={13} /> {diagnostics.length ? `${diagnostics.length} problem${diagnostics.length > 1 ? 's' : ''}` : 'Ready'}</span></div><div className="status-right"><span>UTF-8</span><span>Spaces: 4</span><span>Java</span><Maximize2 size={13} /></div></div>
        </section>

        <div className="panel-resizer vertical" {...resizeHandle('inspector')} />
        <aside className="inspector panel">
          <div className="panel-heading"><div className="panel-label"><span>RUN CONFIGURATION</span></div><button className="mini-icon" title="Configuration"><Settings2 size={15} /></button></div>
          <div className="inspector-content">
            <div className="run-card"><div className="run-card-icon"><TerminalSquare size={17} /></div><div><div className="run-card-title">Java program</div><div className="run-card-subtitle">{runtime.sandboxed ? 'Compile and run in isolation' : 'Compile with the installed JDK'}</div></div><span className={`ready-indicator ${runtime.available ? 'online' : ''}`} title={runtime.available ? runtime.sandboxed ? 'Sandbox ready' : 'Local JDK ready' : runtime.message} /></div>
            <div className="config-section"><div className="config-label">ENTRY POINT</div><div className="config-value"><Braces size={15} /><span>{entryPointName}</span><span className="config-auto">AUTO</span></div></div>
            <div className="config-section"><div className="config-label">LANGUAGE RUNTIME</div><div className="version-card"><span className="version-symbol">☕</span><div className="version-copy"><strong>{runtime.available ? `${runtime.vendor} ${runtime.version}` : 'Java runtime'}</strong><span>{runtime.available ? runtime.sandboxed ? runtime.mode === 'vercel-sandbox' ? 'Vercel Sandbox · isolated' : 'Docker sandbox · isolated' : 'Local JDK · runs on this computer' : runtime.message ?? 'Waiting for runner'}</span></div></div></div>
            <div className="security-note"><div className="security-icon"><Gauge size={15} /></div><div><strong>{runtime.sandboxed ? 'Sandboxed execution' : runtime.available ? 'Local Java execution' : 'Java runner setup'}</strong><span>{runtime.sandboxed ? 'No network · CPU and memory limits · 5s timeout' : runtime.available ? 'Runs with your account permissions. Only execute code you trust.' : runtime.message ?? 'Start the Java runner to compile and run code.'}</span></div></div>
            <div className="shortcut-card"><div className="shortcut-title"><Clock3 size={14} /> QUICK TIP</div><p>Pass values through standard input. Your Java program can read them with <code>Scanner</code> or <code>BufferedReader</code>.</p><button onClick={() => setActiveTerminal('Input')}>Edit input <ChevronRight size={13} /></button></div>
            <div className="mentor-placeholder"><div className="mentor-orb"><Code2 size={17} /></div><div><strong>Build, run, learn.</strong><span>More tools are on the way.</span></div></div>
          </div>
        </aside>
      </section>

      <div className="panel-resizer horizontal" {...resizeHandle('terminal')} />
      <section className={`terminal panel ${terminalCollapsed ? 'terminal-collapsed' : ''}`}>
        <div className="terminal-head"><div className="terminal-tabs">{terminalTabs.map((tab) => <button key={tab} className={`terminal-tab ${tab === activeTerminal ? 'active' : ''}`} onClick={() => setActiveTerminal(tab)}>{tab === 'Output' ? <TerminalSquare size={14} /> : tab === 'Input' ? <Braces size={14} /> : <TriangleAlert size={14} />}<span>{tab}</span>{tab === 'Problems' && diagnostics.length > 0 && <span className="problem-count">{diagnostics.length}</span>}</button>)}</div><div className="terminal-actions">{result && activeTerminal === 'Output' && <span className={`execution-status ${statusTone}`}><span />{result.status.replaceAll('_', ' ')}</span>}{result && activeTerminal === 'Output' && <><span className="metric"><Clock3 size={13} />{result.elapsed_ms} ms</span>{result.memory_mb != null && <span className="metric"><Gauge size={13} />{result.memory_mb} MB</span>}</>}<button className="mini-icon" title="Clear panel" onClick={() => setJob(null)}><Trash2 size={14} /></button><button className="mini-icon" title={terminalCollapsed ? 'Expand panel' : 'Collapse panel'} onClick={() => setTerminalCollapsed((value) => !value)} aria-label={terminalCollapsed ? 'Expand panel' : 'Collapse panel'}><ChevronDown size={15} /></button></div></div>
        <div className={`terminal-body ${activeTerminal === 'Input' ? 'input-mode' : ''}`}>
          {activeTerminal === 'Input' ? <><div className="input-note"><span className="input-dot" /> Standard input <span>Text sent to <code>System.in</code> when you run the program</span></div><textarea aria-label="Program input" value={stdin} onChange={(event) => { setStdin(event.target.value); setJob(null); }} placeholder="Type program input here…" spellCheck={false} /></> : activeTerminal === 'Problems' ? diagnostics.length ? <div className="diagnostic-list">{diagnostics.map((item, index) => <button key={`${item.file}-${item.line}-${index}`} className="diagnostic-row" onClick={() => { setActiveFile(item.file); editorRef.current?.revealLineInCenter(item.line); editorRef.current?.focus(); }}><TriangleAlert size={14} /><span className="diagnostic-location">{item.file}:{item.line}</span><span>{item.message}</span><span className="diagnostic-code">{item.code}</span></button>)}</div> : <div className="empty-problems"><span className="check-mark">✓</span><span>No problems detected</span></div> : <div className={`output-content ${result?.status === 'SUCCESS' ? 'output-good' : ''}`}>{isRunning ? <><span className="spinner" />{job?.status === 'RUNNING' ? `Compiling and running in ${runtime.sandboxed ? 'Java sandbox' : 'local JDK'}…` : `Starting ${runtime.sandboxed ? 'Java sandbox' : 'local Java runner'}…`}</> : terminalContent ? Array.isArray(terminalContent) ? null : terminalContent : <span className="output-placeholder">Run your Java program to see the output here.</span>}</div>}
        </div>
        <div className="terminal-foot"><span><span className={`footer-dot ${runtime.available ? 'online' : ''}`} />{runtime.available ? 'Runner connected' : 'Runner disconnected'}</span><span>{result ? `Exit code ${result.exit_code ?? '—'}` : 'Ready'}</span></div>
      </section>

      {deleteFolderPath && <div className="about-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteFolderPath(null); }}><section className="path-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-folder-title"><div className="path-dialog-heading"><h2 id="delete-folder-title">Delete folder?</h2><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setDeleteFolderPath(null)}><X size={17} /></button></div><p className="delete-folder-copy">Delete <strong>{deleteFolderPath}</strong> and all Java files inside?</p><div className="path-dialog-actions"><button type="button" onClick={() => setDeleteFolderPath(null)}>Cancel</button><button className="danger-button" type="button" onClick={confirmDeleteFolder}>Delete folder</button></div></section></div>}
      {pathError && <div className="path-error-toast" role="alert">{pathError}</div>}
      <footer className="app-footer">
        <span className="footer-product"><span className="footer-live" /> CodeLab Preview</span>
        <div className="app-footer-meta">
          <span className="powered-by-label">Powered by</span>
          <span className="asrvone-wordmark" aria-label="ASRV ONE"><span>ASRV</span><strong> ONE</strong></span>
          <span className="footer-shortcut"><CircleHelp size={12} /> {runShortcut} to run</span>
        </div>
      </footer>

      {aboutOpen && (
        <div className="about-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
          <section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
            <div className="about-heading">
              <div><span className="about-eyebrow">JAVA WORKSPACE</span><h1 id="about-title">About CodeLab</h1></div>
              <button className="about-close icon-button" onClick={() => setAboutOpen(false)} aria-label="Close About CodeLab"><X size={18} /></button>
            </div>
            <p className="about-intro">A focused place to write, compile, and run Java programs, with standard input and compiler diagnostics beside your code.</p>
            <div className="about-workflow">
              <h2>Compiler workflow</h2>
              <ol>
                <li>Choose the Java files in your workspace; CodeLab finds the active main class.</li>
                <li>Add values in <strong>Input</strong> for <code>Scanner</code> or <code>BufferedReader</code>.</li>
                <li>Select <strong>Run</strong> or press <kbd>{isMacPlatform ? 'Cmd' : 'Ctrl'}</kbd> + <kbd>Enter</kbd>.</li>
                <li>Review program output or jump to compiler errors in <strong>Problems</strong>.</li>
              </ol>
            </div>
            <div className="about-author">
              <div className="about-author-mark">S</div>
              <div className="about-author-info">
                <span className="about-eyebrow">BUILT BY</span>
                <h2>I G Siva Shankar</h2>
                <p>Full-stack developer and AI/ML learner pursuing Computer Science (Data Science) at CMR Engineering College, with additional AI/ML studies at IIIT Hyderabad.</p>
                <a href="https://shankar-irla.vercel.app/" target="_blank" rel="noreferrer">Visit author portfolio <ChevronRight size={14} /></a>
              </div>
            </div>
            <div className="about-author">
              <div className="about-author-mark">V</div>
              <div className="about-author-info">
                <span className="about-eyebrow">BUILT BY</span>
                <h2>Vivek Chittibothula</h2>
                <p>I'm a Computer Science (Data Science) student at CMR Engineering College who likes turning ideas into tools people can use. My work spans full-stack apps and AI/ML, with projects in education, workplace systems, and interview practice.</p>
                <p><strong>Focus:</strong> Java, Python, React, Node.js, SQL, machine learning, computer vision, and generative AI. <strong>Education:</strong> B.Tech CSE (Data Science), CMR Engineering College.</p>
                <p><strong>Projects:</strong> IgniteED, Employee Attendance &amp; Payroll System, and AI Interview Coach.</p>
                <blockquote className="about-author-quote">"I learn by building, and build to make ideas useful."</blockquote>
                <div className="about-author-links">
                  <a href="https://vivek-ch-portfolio.vercel.app/" target="_blank" rel="noreferrer">Visit my portfolio <ChevronRight size={13} /></a>
                  <a href="mailto:248R5A6706@gmail.com">Email</a>
                  <a href="https://linkedin.com/in/vivekchittibothula" target="_blank" rel="noreferrer">LinkedIn</a>
                  <a href="https://github.com/VivekChittibothula" target="_blank" rel="noreferrer">GitHub</a>
                  <span>Medchal, Telangana, India</span>
                </div>
              </div>
            </div>
            <div className="about-footer">
              <span>CodeLab · Java compiler workspace</span>
              <span className="asrvone-wordmark" aria-label="ASRV ONE"><span>ASRV</span><strong> ONE</strong></span>
            </div>
          </section>
        </div>
      )}
      {projectDialogOpen && <div className="about-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false); }}><form className="path-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={saveProjectName}><div className="path-dialog-heading"><h2 id="project-dialog-title">Rename project</h2><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setProjectDialogOpen(false)}><X size={17} /></button></div><label htmlFor="project-name">Project name</label><input id="project-name" autoFocus maxLength={48} value={projectNameDraft} onChange={(event) => { setProjectNameDraft(event.target.value); setProjectNameError(''); }} />{projectNameError && <div className="dialog-error" role="alert">{projectNameError}</div>}<div className="path-dialog-actions"><button type="button" onClick={() => setProjectDialogOpen(false)}>Cancel</button><button type="submit">Save name</button></div></form></div>}
      {pathDialog && <div className="about-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPathDialog(null); }}><form className="path-dialog" role="dialog" aria-modal="true" aria-labelledby="path-dialog-title" onSubmit={(event) => { event.preventDefault(); submitPathDialog(); }}><div className="path-dialog-heading"><h2 id="path-dialog-title">{pathDialog.kind === 'folder' ? 'New folder' : pathDialog.kind === 'file' ? 'Rename Java file' : 'Rename folder'}</h2><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setPathDialog(null)}><X size={17} /></button></div><label htmlFor="workspace-path">{pathDialog.kind === 'folder' ? 'Folder path' : pathDialog.kind === 'file' ? 'Java file path' : 'Folder path'}</label><input id="workspace-path" autoFocus value={pathDialog.value} onChange={(event) => { setPathDialog({ ...pathDialog, value: event.target.value }); setPathError(''); }} />{pathError && <div className="dialog-error" role="alert">{pathError}</div>}<div className="path-dialog-actions"><button type="button" onClick={() => setPathDialog(null)}>Cancel</button><button type="submit">{pathDialog.kind === 'folder' ? 'Create folder' : 'Rename'}</button></div></form></div>}
    </main>
  );
}

export default App;
