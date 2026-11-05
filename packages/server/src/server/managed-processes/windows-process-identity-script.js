// Paseo's Windows process identity, run by cscript.exe as JScript against inbox WMI.
//
// This file is ES3 only, with its own JSON writer, because cscript may run it on classic JScript
// or on JScript9Legacy depending on the Windows release. Every non-ASCII character leaves as a
// \u escape, so the output depends on neither the engine nor a console code page. The caller in
// windows-process-identity.ts parses it. The formatter skips this one file, because its trailing
// commas are not valid here; a test in managed-processes.test.ts checks the ES3 constraints.
//
// Output is always one JSON envelope on success:
//   query: {"ok":true,"process":{"ProcessId":1,"CommandLine":"...","CreationDate":"..."}}
//          {"ok":true,"process":null} when no process has that id
//   list:  {"ok":true,"processes":[{"ProcessId":1,"ParentProcessId":0,"CreationDate":"..."}]}
// Anything else, including an exit code other than 0, means the script did not complete.

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

function number(value) {
  return value === null || value === undefined ? "null" : String(value);
}

function query(wql) {
  var service = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2");
  var rows = [];
  for (var e = new Enumerator(service.ExecQuery(wql)); !e.atEnd(); e.moveNext()) {
    rows.push(e.item());
  }
  return rows;
}

function run() {
  var named = WScript.Arguments.Named;
  var mode = named.Item("mode");
  if (mode === "list") {
    var rows = query("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process");
    var items = [];
    for (var i = 0; i < rows.length; i += 1) {
      items.push(
        '{"ProcessId":' + number(rows[i].ProcessId) +
          ',"ParentProcessId":' + number(rows[i].ParentProcessId) +
          ',"CreationDate":' + quote(rows[i].CreationDate) + "}"
      );
    }
    return '{"ok":true,"processes":[' + items.join(",") + "]}";
  }
  if (mode === "query") {
    var pid = String(named.Item("pid"));
    if (!/^[0-9]+$/.test(pid)) throw new Error("pid must be a decimal number");
    var found = query(
      "SELECT ProcessId,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId = " + pid
    );
    if (found.length === 0) return '{"ok":true,"process":null}';
    return (
      '{"ok":true,"process":{"ProcessId":' + number(found[0].ProcessId) +
      ',"CommandLine":' + quote(found[0].CommandLine) +
      ',"CreationDate":' + quote(found[0].CreationDate) + "}}"
    );
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
