"""Runtime metadata (pid/state files, single-instance guard) for the backend.

The single-instance protection lives in ``runtime.singleton``; the files
written to this directory (``backend.pid``, ``backend.state``, …) are advisory
state the launcher and health checks read. Nothing here must be committed —
see the ``runtime/`` entry in ``.gitignore``.
"""