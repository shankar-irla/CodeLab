# CodeLab architecture

## Run path

```text
Monaco workspace
    | POST /api/run
    v
FastAPI API -- asynchronous job record and bounded queue
    | private HTTP request
    v
Java runner -- validates files, compiles, runs, and collects diagnostics
    |-- local mode: installed JDK in a temporary project directory
    `-- Docker mode: disposable, restricted Java container
```

`apps/web` owns the editor, theme, browser-local files, and standard-input text area. `apps/api` validates requests, tracks short-lived jobs, limits concurrent runs, and exposes the REST interface. `services/java-runner` implements the Java runtime contract and selects its execution mode through `JAVA_EXECUTION_MODE`.

The root `npm run dev` command starts the local Java runner, API, and Vite development server. It sets `JAVA_EXECUTION_MODE=local`, so Java can run without Docker. The root `npm run dev:sandbox` command starts the Docker Compose stack, where the runner creates a fresh container for each execution.

## Runtime contract

Each run accepts relative `.java` paths, UTF-8 source, a fully qualified main class, standard input, and a bounded timeout. It returns a terminal status, output, exit code, elapsed time, and structured compiler diagnostics. Only Java is implemented.

Local mode writes the submitted project into a new temporary directory, compiles into a separate classes folder, pipes standard input to `java`, limits JVM heap and execution time, and caps captured output. The Java process uses the permissions of the current OS account. Local mode is for trusted code; it is not an OS sandbox.

Docker mode runs each program with networking disabled, a non-root UID, a read-only root filesystem, a temporary workspace, resource limits, dropped Linux capabilities, and automatic container removal. Only the runner receives access to the Docker Engine socket; the Java execution container never does.

The browser saves the current user's files, standard input, and theme in local storage. The application does not currently include accounts, remote persistence, or shared projects.

## Next phases

1. Persist users, projects, files, problems, executions, and submissions with PostgreSQL and SQLAlchemy.
2. Add drag-and-drop file moves and multi-select operations to the nested browser explorer.
3. Add a problem schema, sample/hidden test runner, and submission statuses on top of the runtime contract.
4. Add a structured Java visualization event helper and a step player.
5. Add provider-neutral AI interfaces only when credentials are configured; code execution remains independent of AI availability.
