import io
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import _archive, _parse_diagnostics, _safe_files  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def test_valid_project_paths_are_kept_relative():
    files, size = _safe_files({"src/Main.java": "class Main {}", "src/Model.java": "class Model {}"})
    assert list(files) == ["src/Main.java", "src/Model.java"]
    assert size > 0


@pytest.mark.parametrize("path", ["../Main.java", "/Main.java", "src/../Main.java", "Main.txt", "src//Main.java"])
def test_invalid_paths_are_rejected(path: str):
    with pytest.raises(HTTPException) as error:
        _safe_files({path: "class Main {}"})
    assert error.value.status_code == 422


def test_source_and_stdin_are_archived_without_host_paths():
    archive = _archive({"pkg/Main.java": "package pkg; class Main {}"}, "42\n")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r") as tar:
        assert set(tar.getnames()) == {"pkg/Main.java", ".codelab-input"}
        assert tar.extractfile(".codelab-input").read() == b"42\n"


def test_compiler_output_becomes_structured_diagnostic():
    output = "/workspace/Main.java:4: error: cannot find symbol\n        missing();\n        ^\n"
    diagnostics = _parse_diagnostics(output)
    assert diagnostics == [{
        "file": "Main.java",
        "line": 4,
        "column": 9,
        "severity": "error",
        "code": "CANNOT_FIND_SYMBOL",
        "message": "cannot find symbol",
    }]
