# Windows terminal startup

On Windows, Paseo++ identifies its own terminal processes through Windows Script Host instead of Windows PowerShell. Windows PowerShell can take long enough to start, especially on Windows ARM64, that the terminal worker missed its startup deadline and the daemon failed to start.

Windows Script Host must be able to run Paseo++'s `windows-process-identity-script.js` with `cscript.exe`. If it is disabled, or AppLocker or App Control blocks scripts on your machine, the daemon cannot start, and its log names the script to allow. Paseo++ does not change these policies itself, and does not fall back to Windows PowerShell.
