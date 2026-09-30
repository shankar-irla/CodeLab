import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react';
import {
  Activity, Braces, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, FileCode2,
  FilePlus2, Folder, Gauge, GitBranch, Layers3, Maximize2, MoreHorizontal, PanelLeftClose,
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
  const [activeFile, setActiveFile] = useState('Main.java');
  const [activeTerminal, setActiveTerminal] = useState<(typeof terminalTabs)[number]>('Output');
  const [stdin, setStdin] = useState(loadSavedStdin);
  const [runtime, setRuntime] = useState<Runtime>({ available: false, language: 'Java', message: 'Checking runtime' });
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('codelab.theme') === 'light' ? 'light' : 'dark');
  const [showSearch, setShowSearch] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const runCodeRef = useRef<() => Promise<void>>(async () => undefined);
  const isRunning = busy && (job?.status === 'QUEUED' || job?.status === 'RUNNING' || job === null);
  const source = files[activeFile] ?? '';
  const entryPointPath = findEntryPoint(files, activeFile);
  const entryPointName = entryPointPath.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.java$/, '') ?? 'Main';
  const result = job?.result;
  const diagnostics = result?.diagnostics ?? [];
  const terminalContent = useMemo(() => {
    if (activeTerminal === 'Input') return null;
    if (activeTerminal === 'Problems') return diagnostics;
    return result?.output ?? (job?.error ? `Runner unavailable\n\n${job.error}` : 'Run your Java program to see the output here.');
  }, [activeTerminal, diagnostics, job, result]);

  useEffect(() => { localStorage.setItem('codelab.files', JSON.stringify(files)); }, [files]);
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
    const timer = window.setInterval(() => { if (!runtime.available) void checkRuntime(); }, 5000);
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
        body: JSON.stringify({ files, stdin, main_class: packageName ? `${packageName}.${mainName}` : mainName, timeout_seconds: 5 }),
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

  const addFile = () => {
    let path = 'Solution.java';
    let index = 2;
    while (files[path]) path = `Solution${index++}.java`;
    setFiles((current) => ({ ...current, [path]: `public class ${path.replace(/\.java$/, '')} {\n    public static void main(String[] args) {\n        // Start writing here\n    }\n}\n` }));
    setActiveFile(path);
  };

  const deleteFile = (name: string) => {
    if (Object.keys(files).length < 2 || name === 'Main.java') return;
    setFiles((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)));
    if (activeFile === name) setActiveFile('Main.java');
  };

  const statusTone = result?.status === 'SUCCESS' ? 'good' : ['COMPILE_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED'].includes(result?.status ?? '') ? 'bad' : 'neutral';
  const filteredFiles = Object.keys(files).filter((name) => name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Code2 size={18} strokeWidth={2.4} /></div><div><div className="brand-name">codelab<span>.</span></div><div className="brand-caption">JAVA WORKSPACE</div></div></div>
        <div className="workspace-crumb"><Folder size={14} /><span>My workspace</span><ChevronRight size={13} /><strong>Untitled project</strong><ChevronDown size={13} /></div>
        <div className="top-actions"><span className={`save-state ${busy ? 'saving' : ''}`}><span className="save-dot" />{busy ? 'Running' : 'Saved locally'}</span><button className="icon-button theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button help-button" onClick={() => setAboutOpen(true)} title="About CodeLab" aria-label="About CodeLab"><CircleHelp size={17} /></button><button className="avatar" title="Local workspace">S</button></div>
      </header>

      <div className="actionbar">
        <div className="action-left"><div className="language-pill"><span className="java-glyph">J</span><span>Java</span><ChevronDown size={13} /></div><span className="divider" /><button className="bar-button" onClick={() => setCollapsed((value) => !value)} title="Toggle explorer"><PanelLeftClose size={16} /><span>Explorer</span></button><button className="bar-button" onClick={() => setShowSearch((value) => !value)} title="Search files"><Search size={16} /><span>Search</span></button></div>
        <div className="action-right"><span className={`runtime-chip ${runtime.available ? 'online' : ''}`}><span className="runtime-dot" />{runtime.available ? `${runtime.sandboxed ? runtime.mode === 'vercel-sandbox' ? 'Vercel Sandbox' : 'Sandbox' : 'Local'} · ${runtime.vendor} ${runtime.version}` : runtime.message ?? 'Java runner offline'}</span><button className="bar-button settings-button" title="Settings"><Settings2 size={16} /></button><button className="run-button" onClick={() => void runCode()} disabled={busy}><Play size={15} fill="currentColor" />{busy ? 'Running' : 'Run'}<kbd>{isMacPlatform ? '⌘ ↵' : 'Ctrl ↵'}</kbd></button>{busy && job?.id && <button className="stop-button" onClick={() => void stopCode()} title="Stop execution"><Square size={14} fill="currentColor" /></button>}</div>
      </div>

      <section className={`workbench ${collapsed ? 'explorer-collapsed' : ''}`}>
        {!collapsed && <aside className="explorer panel">
          <div className="panel-heading"><div className="panel-label"><ChevronDown size={13} /><span>EXPLORER</span></div><div className="heading-actions"><button className="mini-icon" onClick={addFile} title="New Java file"><FilePlus2 size={15} /></button><button className="mini-icon" onClick={addFile} title="More actions"><MoreHorizontal size={16} /></button></div></div>
          <div className="project-label"><ChevronDown size={13} /><span>UNTITLED PROJECT</span><button className="mini-icon" onClick={addFile} title="Add file"><Plus size={14} /></button></div>
          {showSearch && <div className="search-field"><Search size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" autoFocus /><button className="mini-icon" onClick={() => { setShowSearch(false); setFilter(''); }}><X size={13} /></button></div>}
          <div className="file-list">{filteredFiles.map((name) => <div key={name} className={`file-row ${name === activeFile ? 'selected' : ''}`}><button className="file-select" onClick={() => setActiveFile(name)}><FileCode2 size={15} /><span>{name}</span></button>{name !== 'Main.java' && <button className="mini-icon file-delete" onClick={() => deleteFile(name)} title="Delete file"><Trash2 size={13} /></button>}</div>)}</div>
          <div className="explorer-bottom"><div className="project-meta"><Layers3 size={14} /><span>{Object.keys(files).length} {Object.keys(files).length === 1 ? 'file' : 'files'}</span></div><span className="project-lang">Java</span></div>
        </aside>}

        <section className="editor-column panel">
          <div className="editor-tabs"><div className="active-tab"><span className="java-glyph small">J</span><span>{activeFile}</span><span className="tab-unsaved" /></div><div className="tab-spacer" /><button className="mini-icon editor-tool" title="Split editor"><Workflow size={15} /></button><button className="mini-icon editor-tool" title="More editor actions"><MoreHorizontal size={16} /></button></div>
          <div className="breadcrumb"><span>src</span><ChevronRight size={12} /><span>{activeFile}</span><span className="breadcrumb-spacer" /><span className="code-lens">Java</span></div>
          <div className="editor-wrap"><Editor height="100%" language="java" path={activeFile} value={source} onChange={updateSource} onMount={mountEditor} theme={theme === 'light' ? 'codelab-light' : 'codelab-dark'} options={{ automaticLayout: true, fontSize: 14, fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace', lineHeight: 23, minimap: { enabled: true, scale: 0.75 }, scrollBeyondLastLine: false, tabSize: 4, insertSpaces: true, bracketPairColorization: { enabled: true }, guides: { indentation: true }, padding: { top: 14, bottom: 18 }, wordWrap: 'off', renderLineHighlight: 'all', smoothScrolling: true, cursorBlinking: 'smooth', glyphMargin: true }} /></div>
          <div className="statusbar"><div className="status-left"><span><GitBranch size={13} /> main</span><span><Activity size={13} /> {diagnostics.length ? `${diagnostics.length} problem${diagnostics.length > 1 ? 's' : ''}` : 'Ready'}</span></div><div className="status-right"><span>UTF-8</span><span>Spaces: 4</span><span>Java</span><Maximize2 size={13} /></div></div>
        </section>

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

      <section className="terminal panel">
        <div className="terminal-head"><div className="terminal-tabs">{terminalTabs.map((tab) => <button key={tab} className={`terminal-tab ${tab === activeTerminal ? 'active' : ''}`} onClick={() => setActiveTerminal(tab)}>{tab === 'Output' ? <TerminalSquare size={14} /> : tab === 'Input' ? <Braces size={14} /> : <TriangleAlert size={14} />}<span>{tab}</span>{tab === 'Problems' && diagnostics.length > 0 && <span className="problem-count">{diagnostics.length}</span>}</button>)}</div><div className="terminal-actions">{result && activeTerminal === 'Output' && <span className={`execution-status ${statusTone}`}><span />{result.status.replaceAll('_', ' ')}</span>}{result && activeTerminal === 'Output' && <><span className="metric"><Clock3 size={13} />{result.elapsed_ms} ms</span>{result.memory_mb != null && <span className="metric"><Gauge size={13} />{result.memory_mb} MB</span>}</>}<button className="mini-icon" title="Clear panel" onClick={() => setJob(null)}><Trash2 size={14} /></button><button className="mini-icon" title="Collapse panel"><ChevronDown size={15} /></button></div></div>
        <div className={`terminal-body ${activeTerminal === 'Input' ? 'input-mode' : ''}`}>
          {activeTerminal === 'Input' ? <><div className="input-note"><span className="input-dot" /> Standard input <span>Text sent to <code>System.in</code> when you run the program</span></div><textarea aria-label="Program input" value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder="Type program input here…" spellCheck={false} /></> : activeTerminal === 'Problems' ? diagnostics.length ? <div className="diagnostic-list">{diagnostics.map((item, index) => <button key={`${item.file}-${item.line}-${index}`} className="diagnostic-row" onClick={() => { setActiveFile(item.file); editorRef.current?.revealLineInCenter(item.line); editorRef.current?.focus(); }}><TriangleAlert size={14} /><span className="diagnostic-location">{item.file}:{item.line}</span><span>{item.message}</span><span className="diagnostic-code">{item.code}</span></button>)}</div> : <div className="empty-problems"><span className="check-mark">✓</span><span>No problems detected</span></div> : <div className={`output-content ${result?.status === 'SUCCESS' ? 'output-good' : ''}`}>{isRunning ? <><span className="spinner" />{job?.status === 'RUNNING' ? `Compiling and running in ${runtime.sandboxed ? 'Java sandbox' : 'local JDK'}…` : `Starting ${runtime.sandboxed ? 'Java sandbox' : 'local Java runner'}…`}</> : terminalContent ? Array.isArray(terminalContent) ? null : terminalContent : <span className="output-placeholder">Run your Java program to see the output here.</span>}</div>}
        </div>
        <div className="terminal-foot"><span><span className={`footer-dot ${runtime.available ? 'online' : ''}`} />{runtime.available ? 'Runner connected' : 'Runner disconnected'}</span><span>{result ? `Exit code ${result.exit_code ?? '—'}` : 'Ready'}</span></div>
      </section>

      <footer className="app-footer">
        <span className="footer-product"><span className="footer-live" /> CodeLab Preview</span>
        <div className="app-footer-meta">
          <span className="powered-by-label">Powered by</span>
          <img className="asrvone-logo" src={theme === 'dark' ? '/asrvone-logo.svg' : '/asrvone-logo-light.svg'} alt="ASRVOne Shankar" />
          <span className="footer-shortcut"><CircleHelp size={12} /> {runShortcut} to run</span>
        </div>
      </footer>

      {aboutOpen && <div className="about-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title"><div className="about-heading"><div><span className="about-eyebrow">JAVA WORKSPACE</span><h1 id="about-title">About CodeLab</h1></div><button className="about-close icon-button" onClick={() => setAboutOpen(false)} aria-label="Close About CodeLab"><X size={18} /></button></div><p className="about-intro">A focused place to write, compile, and run Java programs, with standard input and compiler diagnostics beside your code.</p><div className="about-workflow"><h2>Compiler workflow</h2><ol><li>Choose the Java files in your workspace; CodeLab finds the active main class.</li><li>Add values in <strong>Input</strong> for <code>Scanner</code> or <code>BufferedReader</code>.</li><li>Select <strong>Run</strong> or press <kbd>{isMacPlatform ? 'Cmd' : 'Ctrl'}</kbd> + <kbd>Enter</kbd>.</li><li>Review program output or jump to compiler errors in <strong>Problems</strong>.</li></ol></div><div className="about-author"><div className="about-author-mark">S</div><div><span className="about-eyebrow">BUILT BY</span><h2>I G Siva Shankar</h2><p>Full-stack developer and AI/ML learner pursuing Computer Science (Data Science) at CMR Engineering College, with additional AI/ML studies at IIIT Hyderabad.</p><a href="https://shankar-irla.vercel.app/" target="_blank" rel="noreferrer">Visit author portfolio <ChevronRight size={14} /></a></div></div><div className="about-footer"><span>CodeLab · Java compiler workspace</span><img src={theme === 'dark' ? '/asrvone-logo.svg' : '/asrvone-logo-light.svg'} alt="ASRVOne Shankar" /></div></section></div>}
    </main>
  );
}

export default App;
