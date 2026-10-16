
#define AppName "AndacCatcher"
#define AppVersion "1.6.0-preview"
#define AppExe "video_downloader.exe"

[Setup]
AppId={{9D859D3E-85C9-4B22-A64D-25B3DFBE60CC}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\AndacCatcher
DefaultGroupName=AndacCatcher
OutputDir=output
OutputBaseFilename=AndacCatcherSetup-preview
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}

[Files]
Source: "..\desktop\target\release\video_downloader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\vendor\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\vendor\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
; FFmpeg license and source-compliance materials
Source: "..\licenses\ffmpeg\*"; DestDir: "{app}\licenses\ffmpeg"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.crx,*.pem,*.key"
Source: "OpenChromeExtensions.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.videocatcher.downloader"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: files; Name: "{app}\native-host.json"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  Json: String;
  ManifestPath: String;
  ExePath: String;
begin
  if CurStep = ssPostInstall then
  begin
    ManifestPath := ExpandConstant('{app}\native-host.json');

    // Native Messaging uygulamasinin tam yolu
    ExePath := ExpandConstant('{app}\video_downloader.exe');

    // JSON icin Windows ters bolu isaretlerini kacir
    StringChangeEx(ExePath, '\', '\\', True);

    // Chrome Native Messaging manifest dosyasi
    Json := '{' + #13#10 +
      '  "name": "com.videocatcher.downloader",' + #13#10 +
      '  "description": "AndacCatcher Native Host",' + #13#10 +
      '  "path": "' + ExePath + '",' + #13#10 +
      '  "type": "stdio",' + #13#10 +
      '  "allowed_origins": ["chrome-extension://fooiadlcldihlgemodgcbkbajblnompo/"]' + #13#10 +
      '}';

    // Manifest dosyasini olustur
    if not SaveStringToFile(ManifestPath, Json, False) then
    begin
      RaiseException(
        'Native Messaging manifest dosyasi olusturulamadi.'
      );
    end;
  end;
end;

[Run]
Filename: "{sys}\explorer.exe"; Parameters: """{app}\extension"""; Description: "AndacCatcher eklenti klasörünü aç"; Flags: postinstall skipifsilent nowait

Filename: "{app}\OpenChromeExtensions.cmd"; Description: "Chrome eklenti yönetimini aç"; Flags: postinstall skipifsilent nowait