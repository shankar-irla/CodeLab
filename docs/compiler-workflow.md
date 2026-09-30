# Java compiler workflow

CodeLab uses the same compile-then-run sequence as a local Java command line. The browser submits source files, the selected entry point, standard input, and the time limit to the CodeLab API.

```text
Select the active .java file
        |
        v
Find its main class (fallback: Main.java, then first class with main)
        |
        v
POST /api/run  -->  validate request and queue a short-lived job
        |
        v
Java runner writes project files into a fresh temporary directory
        |
        v
javac compiles all submitted .java files into a separate classes directory
        |                                  \
        | success                           \ compile diagnostics
        v                                    v
java runs the entry point              COMPILE_ERROR + Problems
with provided standard input
        |
        v
stdout / stderr, exit code, time  -->  Output and Problems panels
```

## From the editor

1. Create or select Java source files in Explorer.
2. Add test values in **Input**. Each line is sent to `System.in`; use Java's `Scanner` or `BufferedReader` to read it.
3. Select **Run** or press `Ctrl+Enter` (`Cmd+Enter` on macOS).
4. The browser polls the returned job until it completes. **Output** displays standard output/error and the exit status. **Problems** lists `javac` diagnostics and can navigate to the indicated file and line.

The active file is used if it has a `main` method. Otherwise the app prefers `Main.java`, then the first submitted Java file containing `main`. The class name and an optional package declaration are sent as the entry point.

## Runtime modes

| Mode | How compilation runs | Isolation |
| --- | --- | --- |
| Local (`npm run dev`) | Uses the installed `javac` and `java` executables in a temporary workspace. | Time, JVM heap, and output are bounded. Java inherits the local account's operating-system permissions; this is not a security sandbox. |
| Docker (`npm run dev:sandbox`) | The runner starts a disposable container for each job using the bundled Java runtime image. | Container networking is disabled; the runner applies CPU, memory, process, timeout, filesystem, and Linux capability restrictions. |

The browser does not execute Java. It sends jobs to FastAPI, which forwards them to the Java runner. See [architecture.md](architecture.md) for service responsibilities and [deploy-vercel.md](deploy-vercel.md) for the public deployment boundary.
