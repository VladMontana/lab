# 🌐 Руководство: Подключение своего домена и HTTPS через Caddy

В проект добавлен веб-сервер и обратный прокси **Caddy**.  
Главное преимущество Caddy перед Nginx — **полностью автоматический HTTPS**: вам **не нужен Certbot**, не нужно вручную вводить команды выпуска сертификатов и настраивать cron-задачи. Caddy сам получает бесплатный SSL-сертификат (Let's Encrypt / ZeroSSL), устанавливает его, продлевает каждые 60 дней и автоматически перенаправляет трафик с HTTP на HTTPS.

---

## 📁 Структура файлов

```text
caddy/
├── Caddyfile                 # Активный конфигурационный файл (по умолчанию режим HTTP, порт 80)
├── Caddyfile.https.example   # Готовый шаблон для продакшена с HTTPS и вашим доменом
└── certs/                    # Папка для собственных SSL-сертификатов (если не используете Let's Encrypt)
```

---

## 🚀 Пошаговая инструкция

### Шаг 1: Привязка домена (DNS)
У вашего регистратора домена (Reg.ru, Beget, Cloudflare, Namecheap и др.) добавьте **A-записи**, указывающие на публичный IP-адрес вашего сервера:
* `@` (или ваш домен, например `labnotes.ru`) &rarr; `IP_ВАШЕГО_СЕРВЕРА`
* `www` (или поддомен) &rarr; `IP_ВАШЕГО_СЕРВЕРА`

---

### Шаг 2: Первичный запуск (Режим HTTP)
По умолчанию в файле `caddy/Caddyfile` уже настроен режим HTTP (порт 80):
```bash
docker compose up -d
```
После этого сайт сразу начнёт открываться в браузере по вашему IP или домену по обычному `http://`.

---

### Шаг 3: Включение HTTPS и получение SSL-сертификата

1. Откройте файл `caddy/Caddyfile.https.example`.
2. Замените `your-domain.com` на ваш реальный домен, а `admin@your-domain.com` на ваш email:
   ```caddyfile
   yourdomain.ru, www.yourdomain.ru {
       tls admin@yourdomain.ru
       
       reverse_proxy app:8080 {
           header_up Host {host}
           header_up X-Real-IP {remote_host}
           header_up X-Forwarded-For {remote_host}
           header_up X-Forwarded-Proto https
       }
       
       encode zstd gzip
       request_body {
           max_size 100MB
       }
   }
   ```
3. Скопируйте этот шаблон поверх основного `Caddyfile`:
   * **Linux / macOS:**
     ```bash
     cp caddy/Caddyfile.https.example caddy/Caddyfile
     ```
   * **Windows (PowerShell):**
     ```powershell
     Copy-Item caddy/Caddyfile.https.example caddy/Caddyfile
     ```
4. Примените конфигурацию на лету (без остановки контейнеров):
   ```bash
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

**Готово!** Caddy сам свяжется с Let's Encrypt, подтвердит владение доменом, получит SSL-сертификат и включит безопасное соединение. Все запросы на `http://` будут автоматически перенаправляться на `https://`.

---

### Шаг 4: Настройка переменных окружения в `.env`

На сервере в файле `.env` укажите ваш домен и включите защищённые куки:
```env
APP_BASE_URL=https://yourdomain.ru
COOKIE_SECURE=true
```
После чего перезапустите сервис приложения:
```bash
docker compose up -d app
```

---

## ❓ Частые вопросы

### Как использовать собственные сертификаты (например, Cloudflare Origin Certificate)?
Если вы не хотите выпускать сертификат через Let's Encrypt, а имеете свои файлы:
1. Положите файлы в папку `caddy/certs/cert.pem` и `caddy/certs/key.pem`.
2. В блоке вашего домена в `Caddyfile` укажите:
   ```caddyfile
   tls /etc/caddy/certs/cert.pem /etc/caddy/certs/key.pem
   ```
3. Перезагрузите Caddy:
   ```bash
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

### Как посмотреть логи Caddy?
```bash
docker compose logs -f caddy
```
