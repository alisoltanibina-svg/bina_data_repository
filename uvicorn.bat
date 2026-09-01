echo off

:: 1. Start the FastAPI backend on its default port (8000) in a new window
start "FastAPI Backend" python -m uvicorn backend.main:app --reload

:: 2. Start the Frontend server on a DIFFERENT port (8080) in a new window
start "Frontend Server" python -m http.server 8080

:: 3. Wait 2 seconds for the servers to boot up
timeout /t 2 /nobreak >nul

:: 4. Automatically open your browser to the frontend
start http://localhost:8080