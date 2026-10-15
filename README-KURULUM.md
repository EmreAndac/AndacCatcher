# AndacCatcher Windows kurulum paketi (preview)

Bu ZIP **hazir bir kurulum EXE dosyasi degildir**; kaynak kod yamasini ve Inno Setup tarifini icerir.

## Projeye yerlestirme

- `desktop/src/main.rs` dosyasini mevcut projedeki dosyanin yerine koyun (once yedek alin).
- `installer/` klasorunu proje kokune kopyalayin.
- Proje kokunde `vendor/` klasoru acin ve guvenilir FFmpeg Windows dagitimindan `ffmpeg.exe` ile `ffprobe.exe` dosyalarini yerlestirin. Lisans kosullarini inceleyin.
- Proje kokunde `extension/` klasoru ve guncel Chrome eklentisi dosyalari bulunmali.

## Derleme

```powershell
cd desktop
cargo build --release
cd ..
.\installer\build.ps1
```

Inno Setup 6 kurulu olmalidir. Cikti `installer/output/AndacCatcherSetup-preview.exe` altinda olusur.

## Preview sinirlari

- Manifest, yalnizca **falodbhmkpjcbpmekmkpochinicfcjac** eklenti kimligine izin verir. Bu kimlik baska bilgisayarda otomatik korunmaz. Genel dagitim icin Chrome Web Store'da sabit kimlikli eklenti yayimlayin ve allowed_origins degerini o kimlige gore guncelleyin.
- Chrome, paketlenen unpacked eklentiyi kullanicinin onayi olmadan otomatik yuklemez. Kullanici `chrome://extensions` > Gelistirici modu > Paketlenmemis oge yukle ile `{localappdata}\Programs\AndacCatcher\extension` klasorunu secer.
- Installer Chrome uzantisinin farkli ID ile yuklenmesi halinde baglantiyi duzeltmez.
- Bu paket Windows ortaminda derlenip test edilmedi. Genel kullanima sunmadan once temiz bir Windows makinede kurulum, indirme ve kaldirma testleri yapin.
- Native Messaging host adi `com.videocatcher.downloader` olarak korunmustur.
- EXE'yi ve FFmpeg'i dagitirken lisans ve kod imzalama gereksinimlerini degerlendirin.
