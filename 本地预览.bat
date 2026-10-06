@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  方块梦工厂 · 本地预览  http://localhost:8787
echo  （未连接后端时自动进入演示模式）
echo.
start "" http://localhost:8787
python -m http.server 8787 --directory public
pause
