# 🌐 Руководство: Подключение своего домена и HTTPS (SSL)

В проект добавлен готовый обратный прокси-сервер **Nginx** и контейнер **Certbot** для автоматического получения и продления бесплатных SSL-сертификатов Let's Encrypt.

---

## 📁 Структура конфигураций

```text
nginx/
├── nginx.conf                 # Главная оптимизированная конфигурация Nginx (Gzip, 100M лимит, воркеры)
├── conf.d/
│   ├── default.conf           # Активная конфигурация HTTP (порт 80, ACME challenge, прокси в LabNotes)
│   └── https.conf.example     # Готовый шаблон HTTPS (порт 443, SSL, 301 редирект с HTTP, HSTS)
└── certs/                     # Папка для ваших собственных SSL сертификатов (если используете не Let's Encrypt)
```

---

## 🚀 Пошаговая инструкция

### Шаг 1: Привязка домена (DNS)
У вашего регистратора домена (Reg.ru, Beget, Cloudflare, Namecheap и др.) добавьте **A-записи**, указывающие на публичный IP-адрес вашего сервера:
* `@` (или имя домена, например `labnotes.ru`) &rarr; `IP_ВАШЕГО_СЕРВЕРА`
* `www` (или поддомен) &rarr; `IP_ВАШЕГО_СЕРВЕРА`

---

### Шаг 2: Первичный запуск (HTTP)
Nginx уже настроен и готов принимать запросы по HTTP (порт 80):
```bash
docker compose up -d
```
После этого сайт сразу откроется по вашему домену (или IP) на 80 порту.

---

### Шаг 3: Получение SSL-сертификата

#### Вариант А: Бесплатный Let's Encrypt через Certbot (Рекомендуется)
Выполните одну команду, заменив `yourdomain.ru` и email на свои:
```bash
docker compose run --rm certbot certonly --webroot --webroot-path /var/www/certbot \
  -d yourdomain.ru -d www.yourdomain.ru \
  --email admin@yourdomain.ru --agree-tos --no-eff-email
```
Сертификаты автоматически сохранятся в защищенный том `labnotes_certbot_certs`.

#### Вариант Б: Собственные SSL-сертификаты
Если у вас уже есть сертификаты (например, от Cloudflare или коммерческого CA):
1. Положите файл полного сертификата в `nginx/certs/fullchain.pem`
2. Положите файл приватного ключа в `nginx/certs/privkey.pem`

---

### Шаг 4: Активация HTTPS в Nginx

1. Откройте файл `nginx/conf.d/https.conf.example` и укажите ваш домен:
   ```nginx
   server_name yourdomain.ru www.yourdomain.ru;
   ```
   *(Также проверьте путь к сертификатам: для Let's Encrypt оставьте как есть, для своих сертификатов раскомментируйте Вариант Б)*.

2. Замените рабочий файл `default.conf` на HTTPS-конфигурацию:
   * **Linux / macOS:**
     ```bash
     cp nginx/conf.d/https.conf.example nginx/conf.d/default.conf
     ```
   * **Windows (PowerShell):**
     ```powershell
     Copy-Item nginx/conf.d/https.conf.example nginx/conf.d/default.conf
     ```

3. Примените конфигурацию на лету (без простоя сайта):
   ```bash
   docker compose exec nginx nginx -s reload
   ```

Теперь Nginx:
* Принимает безопасные соединения по **HTTPS (порт 443)** с протоколами TLS 1.2 и TLS 1.3.
* Все запросы с **HTTP (порт 80)** автоматически перенаправляет на HTTPS с 301 кодом (Permanent Redirect).
* Сохраняет доступ к пути `/.well-known/acme-challenge/` для автопродления сертификатов.

---

### Шаг 5: Настройка переменных окружения

В файле `.env` на сервере обновите параметры для работы по безопасному протоколу:
```env
APP_BASE_URL=https://yourdomain.ru
COOKIE_SECURE=true
```
И примените изменения:
```bash
docker compose up -d app
```

---

## 🔄 Автоматическое продление сертификатов Let's Encrypt

Сертификаты Let's Encrypt действуют 90 дней.

* **Вручную проверить и продлить:**
  ```bash
  docker compose run --rm certbot renew
  docker compose exec nginx nginx -s reload
  ```
* **Или запустить фоновый демон продления:**
  ```bash
  docker compose --profile certbot up -d certbot
  ```
  *(Демон Certbot будет автоматически проверять необходимость обновления каждые 12 часов).*
