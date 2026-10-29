import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_models_match_migrations(migrated_db):
    result = subprocess.run([sys.executable, "-m", "alembic", "-c", str(ROOT / "alembic.ini"), "check"], cwd=ROOT,
                            env={**os.environ, "DATABASE_URL": migrated_db}, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "No new upgrade operations detected" in result.stdout + result.stderr
