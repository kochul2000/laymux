"""Make the flat `devinput` modules importable (`import guard`, `import probe`).

Run from the repo root:

    uv run --with pytest python -m pytest scripts/devinput/tests -q
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
