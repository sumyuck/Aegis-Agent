"""Vercel serverless entry point.

Vercel checks the filesystem before applying rewrites, so `/demo/*`, `/tools/*` and
`/extension/*` are served as static assets and never reach this function. Only the
API routes do.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from main import app  # noqa: E402  (path bootstrap must run first)

# Vercel's Python runtime discovers the ASGI application by this name.
__all__ = ["app"]
