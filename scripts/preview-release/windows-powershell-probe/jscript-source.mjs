// The ES3 JScript-with-WMI candidate that cscript runs during the probe.

/**
 * The candidate under measurement, run by cscript. ES3 only, with its own JSON writer that escapes
 * every non-ASCII character, so its output depends on neither the script engine nor a code page.
 * Windows 11 24H2 and later may route JScript to JScript9Legacy, so `engine` reports what ran.
 */
export const JSCRIPT_WMI_SOURCE = String.raw`
function quote(value) {
  if (value === null || value === undefined) return "null";
  var text = String(value);
  var out = '"';
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code === 34 || code === 92) {
      out += "\\" + text.charAt(i);
    } else if (code < 32 || code > 126) {
      var hex = code.toString(16);
      while (hex.length < 4) hex = "0" + hex;
      out += "\\u" + hex;
    } else {
      out += text.charAt(i);
    }
  }
  return out + '"';
}
function query(wql) {
  var service = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2");
  var rows = [];
  for (var e = new Enumerator(service.ExecQuery(wql)); !e.atEnd(); e.moveNext()) rows.push(e.item());
  return rows;
}
function run() {
  var named = WScript.Arguments.Named;
  var mode = named.Item("mode");
  if (mode === "engine") {
    return '{"name":' + quote(ScriptEngine()) + ',"major":' + ScriptEngineMajorVersion() +
      ',"minor":' + ScriptEngineMinorVersion() + ',"build":' + ScriptEngineBuildVersion() +
      ',"jsonGlobal":' + (typeof JSON !== "undefined") + "}";
  }
  if (mode === "list") {
    var rows = query("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process");
    var items = [];
    for (var i = 0; i < rows.length; i += 1) {
      items.push('{"ProcessId":' + rows[i].ProcessId + ',"ParentProcessId":' + rows[i].ParentProcessId +
        ',"CreationDate":' + quote(rows[i].CreationDate) + "}");
    }
    return "[" + items.join(",") + "]";
  }
  if (mode === "query") {
    var pid = String(named.Item("pid"));
    if (!/^[0-9]+$/.test(pid)) throw new Error("pid must be numeric");
    var found = query("SELECT ProcessId,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId = " + pid);
    if (found.length === 0) return "";
    return '{"ProcessId":' + found[0].ProcessId + ',"CommandLine":' + quote(found[0].CommandLine) +
      ',"CreationDate":' + quote(found[0].CreationDate) + "}";
  }
  throw new Error("unknown mode");
}
var exitCode = 0;
try {
  WScript.StdOut.Write(run());
} catch (error) {
  WScript.StdErr.WriteLine(String(error.message));
  exitCode = 3;
}
WScript.Quit(exitCode);
`;
