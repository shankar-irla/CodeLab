<div align="center">

# CodeLab

### Think it. Code it. Run it.

**A Java workspace in your browser, built for the moments when an idea needs to become an experiment.**

[![Open CodeLab](https://img.shields.io/badge/Try%20CodeLab-Live-21a179?style=for-the-badge)](https://asrvone-codelab.vercel.app)
[![GitHub repository](https://img.shields.io/badge/GitHub-Source%20code-24292f?style=for-the-badge&logo=github)](https://github.com/shankar-irla/CodeLab)

**No local JDK setup. No need to ask for the answer. Just open, write, run, and learn.**

</div>

<p align="center">
	<a href="docs/screenshots/01-workspace.png"><img src="docs/screenshots/01-workspace.png" alt="CodeLab workspace showing the Java editor and output panel" width="900"></a>
</p>

<p align="center"><em>Your next Java experiment is one browser tab away.</em></p>

## The story behind CodeLab

Sometimes the best way to understand a technology is to build with it.

I wanted a place to open a JDK from anywhere, write Java quickly, and test an idea the moment it showed up. Sure, I could ask an AI tool for an answer. But sometimes I don't want the answer. I want to write the logic, make mistakes, debug them, and understand why it works.

That thought became CodeLab.

The idea was simple. Making a real JDK execution environment work with a Vercel deployment was not. We had to work through the execution architecture and sandboxing, experimenting, breaking things, debugging, and trying again. My close friend and partner in all our technical adventures, [Vivek Chittibothula](https://www.linkedin.com/in/vivekchittibothula/), contributed significantly to the engineering and helped solve the JDK environment challenge.

We didn't set out to claim we had invented online coding. We wanted to solve a problem for ourselves, learn the technology underneath it, and build our own implementation. Something I needed became something we could use together, and then something we could share.

**CodeLab is for students practicing Java, developers testing an idea, and anyone who wants to learn by working through the problem themselves.**

> Open -> Think -> Code -> Run -> Experiment -> Learn

## See it in action

<table>
	<tr>
		<td align="center"><a href="docs/screenshots/02-input.png"><img src="docs/screenshots/02-input.png" alt="Entering standard input for a Java program" width="420"></a><br><strong>Work with standard input</strong></td>
		<td align="center"><a href="docs/screenshots/03-output.png"><img src="docs/screenshots/03-output.png" alt="Successful Java program output" width="420"></a><br><strong>Compile and inspect output</strong></td>
	</tr>
	<tr>
		<td align="center"><a href="docs/screenshots/06-selected-file-hotkey.png"><img src="docs/screenshots/06-selected-file-hotkey.png" alt="Ctrl+Enter runs the selected Solution.java file" width="420"></a><br><strong>Run the selected Java file</strong></td>
		<td align="center"><a href="docs/screenshots/04-about.png"><img src="docs/screenshots/04-about.png" alt="CodeLab About dialog showing compiler steps and author details" width="420"></a><br><strong>See the compile workflow</strong></td>
	</tr>
</table>

<p align="center"><a href="docs/screenshots/05-light-theme.png">Also available in a carefully matched light theme.</a></p>

## What you can do

- Edit Java in a Monaco-powered workspace with nested project files.
- Compile and run a selected Java file, with support for multiple files in one project.
- Provide standard input and inspect program output and runtime errors.
- Read structured compiler diagnostics and jump to the reported source line.
- Save files, input, and theme in browser local storage, with no account required.
- Choose local JDK execution while developing, isolated Docker containers locally, or the deployed Vercel Sandbox runtime.

## Compile and run

1. Open the workspace and create or edit a `.java` file.
2. Add a class with `public static void main(String[] args)`. CodeLab runs the active file when it contains `main`; otherwise it selects `Main.java`, then the first file containing `main`.
3. Select **Input** to provide lines read from `System.in` using `Scanner` or `BufferedReader`.
4. Select **Run** or press **Ctrl+Enter** (**Cmd+Enter** on macOS).
5. Inspect **Output** and **Problems**. Select a compiler diagnostic to open its source location.

`Main.java`, `Solution.java`, and additional files are submitted as one project. The runner creates a temporary project directory for each run and removes it when the job finishes. Browser data is local to that browser profile; it is not synced across devices.

## Run locally

### Requirements

- Node.js 20 or newer and npm
- Python 3.12 or newer
- A JDK with both `java` and `javac` on `PATH`, or `JAVA_HOME` configured
- Docker Desktop or Docker Engine only for isolated container runs

Install dependencies from the repository root:

**Windows PowerShell**

```powershell
npm ci
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.txt -r services/java-runner/requirements.txt
```

**macOS / Linux**

```sh
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r apps/api/requirements.txt -r services/java-runner/requirements.txt
```

Start the API, Java runner, and web app together:

```sh
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The runtime badge shows the detected local JDK. The launcher reuses a Vite server already listening on port 5173 and prints the platform-specific Python environment path if dependencies need installing.

### Execution modes

`npm run dev` uses the JDK installed on your development computer. It creates temporary source and class directories, sets JVM memory and execution-time limits, bounds captured output, and binds local services to loopback. **Local mode is not an operating-system security sandbox:** Java code has the permissions of the account running the app. Use it only for code you trust.

For isolated container execution, install and start Docker Desktop (Windows and macOS) or Docker Engine (Linux), then run:

```sh
npm run dev:sandbox
```

Docker Compose builds the Java runtime and starts the web app, API, and runner. Each execution uses a disposable container with networking disabled and CPU, memory, process, and time limits. Inspect service health with `docker compose ps`; view logs with `docker compose logs api java-runner`.

`npm run dev:web` starts only the editor and needs a CodeLab API at `http://localhost:8000` to execute programs.

## How the deployed runner works

The root `vercel.json` configures the Vite editor, FastAPI API, and internal Java runner as Vercel Services. Java code runs in a network-disabled Vercel Sandbox microVM using a custom OpenJDK image in Vercel Container Registry. The local development queue keeps jobs in memory; Vercel uses a synchronous request flow instead.

Each visitor has a separate browser-local workspace. This version has no accounts, shared projects, or cross-device sync.

## What's next

CodeLab is V1. The bigger vision goes beyond writing and running code:

> Understand -> Plan -> Code -> Compile -> Debug -> Optimize -> Test -> Visualize -> Submit -> Compete -> Improve

More features are coming. What is one feature you would want in your ideal coding environment?

## Project docs

- [End-to-end project documentation, SRS, diagrams, and user manual](docs/project-documentation.md)
- [Compiler workflow](docs/compiler-workflow.md)
- [Architecture and runtime contract](docs/architecture.md)
- [Vercel multi-service deployment](docs/deploy-vercel.md)

## Built together

Created by [Shankar Irla](https://github.com/shankar-irla) with significant engineering collaboration from [Vivek Chittibothula](https://github.com/vivekchittibothula).

<p align="center"><strong>Built because we needed it. Shared so you can build something with it.</strong></p>
