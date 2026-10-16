<div align="center">

# AndacCatcher — Türkçe Kurulum Rehberi

**Windows'ta Chrome üzerinden video indirmek için adım adım kurulum.**

[**Kurulum Dosyasını İndir**](https://github.com/EmreAndac/AndacCatcher/releases) · [**English README**](README.md) · [**Geliştirici Kurulumu**](#geliştiriciler-için-kaynak-koddan-derleme)

</div>

> [!IMPORTANT]
> **Arkadaşlarınızın kullanması için:** GitHub'daki **[Releases](https://github.com/EmreAndac/AndacCatcher/releases)** sayfasından `AndacCatcherSetup-preview.exe` dosyasını indirin. **Code → Download ZIP** düğmesi hazır uygulamayı değil, kaynak kodunu indirir.

## 1. Gereksinimler

- Windows 64-bit bilgisayar
- Google Chrome

**Rust, Cargo, FFmpeg veya Inno Setup kurmanız gerekmez.** FFmpeg ve FFprobe, hazır Windows kurulum paketine dahildir.

## 2. Windows uygulamasını kurun

1. [AndacCatcher Releases](https://github.com/EmreAndac/AndacCatcher/releases) sayfasını açın.
2. Yayınlandığında **Assets** bölümündeki `AndacCatcherSetup-preview.exe` dosyasını indirin.
3. İndirdiğiniz dosyayı çalıştırın ve kurulum sihirbazını tamamlayın.
4. Kurulum, indirme uygulamasını ve FFmpeg'i yükler; Chrome Native Messaging bağlantısını otomatik kaydeder.

> [!NOTE]
> Kurulum sonunda Chrome eklentileri sayfası ve eklenti klasörü açılabilir. Açılmazsa aşağıdaki adımları kendiniz uygulayın.

## 3. Chrome eklentisini etkinleştirin

1. Chrome'un adres çubuğuna `chrome://extensions` yazıp Enter'a basın.
2. Sağ üstteki **Geliştirici modu** seçeneğini açın.
3. Sol üstteki **Paketlenmemiş öğe yükle** düğmesine tıklayın.
4. Klasör seçme penceresinin adres çubuğuna şu yolu yapıştırıp Enter'a basın:

   ```text
   %LOCALAPPDATA%\Programs\AndacCatcher\extension
   ```

5. **Klasör Seç** düğmesine basın.
6. **AndacCatcher** eklentisinin Chrome'da göründüğünü doğrulayın. İsterseniz uzantılar menüsünden sabitleyin.

**Eklenti ID'sini kendiniz oluşturmanız, kopyalamanız veya değiştirmeniz gerekmiyor.** Kurulum paketindeki eklenti ve Native Messaging ayarı birbiriyle uyumlu olacak şekilde hazırlanmıştır.

## 4. Video indirin

1. Chrome'da indirme izniniz olan bir videonun sayfasını açın.
2. Gerekirse videoyu oynatın.
3. AndacCatcher eklentisini açın.
4. Algılanan video kaynağını ve sunuluyorsa kalite seçeneğini belirleyin.
5. İndirmeyi başlatın; ilerlemeyi ve geçmişi eklentiden takip edin.

## Sık karşılaşılan sorunlar

| Sorun | Çözüm |
| --- | --- |
| Eklenti Chrome'da görünmüyor | `chrome://extensions` sayfasından kurulu `extension` klasörünü yükleyin. |
| Native Messaging bağlantı hatası | Windows kurulumunun tamamlandığını doğrulayın; kurulum paketini yeniden çalıştırın. |
| Video algılanmıyor | Sayfayı yenileyin ve videoyu başlatıp yeniden deneyin. Bazı siteler desteklenmeyebilir. |
| Kalite seçeneği yok | Video kaynağı birden fazla kalite sunmuyor olabilir. |
| Windows güvenlik uyarısı | Preview kurulum dosyası dijital olarak imzalanmamış olabilir. Yalnızca güvenilir kaynaktan indirin; güvenlik korumalarını devre dışı bırakmayın. |

> [!WARNING]
> DRM korumalı içerikler desteklenmez. Yalnızca indirme hakkına sahip olduğunuz videoları indirin. Bazı akışlar erişim kısıtlaması nedeniyle indirilemeyebilir.

---

## Geliştiriciler için kaynak koddan derleme

**Bu bölüm normal kullanıcılar için değildir.** Arkadaşlarınızın yalnızca yukarıdaki hazır EXE'yi kullanması yeterlidir.

### Gerekli araçlar

- Rust ve Cargo
- Inno Setup (projenin `installer/build.ps1` betiğiyle uyumlu sürüm)
- Windows için uygun `ffmpeg.exe` ve `ffprobe.exe`
- Google Chrome

### Kaynak kodu hazırlama

```powershell
git clone https://github.com/EmreAndac/AndacCatcher.git
cd AndacCatcher
```

Proje kökünde `vendor/` klasörünü oluşturup lisans koşullarını kontrol ettiğiniz FFmpeg ve FFprobe dosyalarını buraya yerleştirin.

### Derleme

```powershell
cd desktop
cargo build --release
cd ..
.\installer\build.ps1
```

Derleme başarılıysa kurulum paketi `installer/output/AndacCatcherSetup-preview.exe` yolunda oluşturulur.

### Teknik notlar

- Native Messaging host adı: `com.videocatcher.downloader`.
- `extension/manifest.json` içindeki **açık anahtar**, eklenti kimliğini sabit tutmak içindir. Özel `.pem` anahtarını GitHub'a göndermeyin.
- `installer/AndacCatcher.iss` içindeki `allowed_origins`, paketlenen eklentinin ID'siyle eşleşmelidir.
- `vendor/`, Rust derleme çıktıları ve kurulum EXE çıktıları Git deposunda tutulmaz; hazır EXE GitHub Releases üzerinden ayrıca paylaşılır.
- Dağıtıma dahil edilen FFmpeg 9.0.2 Gyan.dev Essentials derlemesi GPLv3 veya sonraki sürüm kapsamındadır. Lisans metni ve bildirimler `licenses/ffmpeg/` altındadır. FFmpeg'in tam karşılık gelen kaynak kodunu ve gerekli derleme materyallerini sağlama yükümlülüğü ayrıca yerine getirilmelidir.

## Proje hakkında

AndacCatcher, Chrome Manifest V3 eklentisi, Rust Native Messaging uygulaması ve FFmpeg ile geliştirilen deneysel bir projedir. Ayrıntılı özellikler, ekran görüntüleri ve İngilizce açıklamalar için [ana README dosyasına](README.md) bakabilirsiniz.
