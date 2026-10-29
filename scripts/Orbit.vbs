' ORBIT launcher (used by the Desktop and Start Menu shortcuts).
' Starts the local server silently when it is not already running, then opens
' ORBIT in its own Microsoft Edge app window. A server started from here
' stops by itself about 20 minutes after the ORBIT window is closed.
Option Explicit

Dim sh, fso, root, port, idle, url, i, ready, edge, dataDir, logDir

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
port = "4320"
idle = "20"

' Optional overrides from .env (ORBIT_PORT, ORBIT_IDLE_EXIT_MIN)
If fso.FileExists(root & "\.env") Then
  Dim f, line
  Set f = fso.OpenTextFile(root & "\.env", 1)
  Do Until f.AtEndOfStream
    line = Trim(f.ReadLine)
    If Left(line, 11) = "ORBIT_PORT=" Then port = Trim(Mid(line, 12))
    If Left(line, 20) = "ORBIT_IDLE_EXIT_MIN=" Then idle = Trim(Mid(line, 21))
    If Left(line, 14) = "AURAJOBS_PORT=" Then port = Trim(Mid(line, 15))
    If Left(line, 23) = "AURAJOBS_IDLE_EXIT_MIN=" Then idle = Trim(Mid(line, 24))
  Loop
  f.Close
End If
url = "http://127.0.0.1:" & port

Function IsUp()
  Dim req
  On Error Resume Next
  Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  req.setTimeouts 1000, 1000, 1000, 1000
  req.open "GET", url & "/api/health", False
  req.send
  IsUp = (Err.Number = 0)
  If IsUp Then IsUp = (req.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not IsUp() Then
  If Not fso.FolderExists(root & "\node_modules") Then
    ' First launch on this computer: the visible launcher installs everything.
    sh.Run """" & root & "\start-orbit.bat""", 1, False
    WScript.Quit
  End If

  If Not fso.FileExists(root & "\dist\web\index.html") Then
    sh.Run "cmd /c cd /d """ & root & """ && npm run build", 0, True
  End If

  dataDir = root & "\data"
  logDir = dataDir & "\logs"
  If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
  If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

  sh.Run "cmd /c cd /d """ & root & """ && set ORBIT_LAUNCHED_BY=app&& set ORBIT_IDLE_EXIT_MIN=" & idle & "&& node --disable-warning=ExperimentalWarning --import tsx server/index.ts > """ & logDir & "\server-console.log"" 2>&1", 0, False

  ' The first launch reads the document folders, which takes a few more seconds.
  ready = False
  For i = 1 To 160
    WScript.Sleep 250
    If IsUp() Then
      ready = True
      Exit For
    End If
  Next
  If Not ready Then
    MsgBox "ORBIT n'a pas pu démarrer." & vbCrLf & vbCrLf & "Lancez start-orbit.bat dans le dossier ORBIT pour voir le problème, ou ouvrez data\logs\server-console.log.", vbExclamation, "ORBIT"
    WScript.Quit 1
  End If
End If

edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=" & url & "/", 1, False
Else
  sh.Run url & "/", 1, False
End If
