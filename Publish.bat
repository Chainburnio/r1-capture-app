@echo off
cd /d "%~dp0"
echo Publishing Capture to GitHub...
echo.
git pull --rebase --autostash
git add -A
git commit -m "Update Capture"
git push
echo.
echo Done. The update goes live in about 2 minutes. Then close and reopen Capture on the r1.
pause
