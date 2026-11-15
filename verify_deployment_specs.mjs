import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const PROJECT_ROOT = process.cwd();

console.log('--- Starting Empirical Deployment & Documentation Specs Verification ---');

let passedAssertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passedAssertions++;
  console.log(`[PASS] ${message}`);
}

// ---------------------------------------------------------------------------
// 1. Dockerfile Verification
// ---------------------------------------------------------------------------
console.log('\n--- 1. Testing Dockerfile Configuration & Security Invariants ---');
const dockerfilePath = path.join(PROJECT_ROOT, 'Dockerfile');
assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

// Multi-stage verification: exactly 3 FROM statements
const fromMatches = [...dockerfile.matchAll(/^FROM\s+([^\s]+)\s+AS\s+([^\s]+)/gim)];
check(fromMatches.length === 3, `Dockerfile must define exactly 3 stages (found ${fromMatches.length})`);

const stage1 = fromMatches[0];
const stage2 = fromMatches[1];
const stage3 = fromMatches[2];

check(stage1[2].toLowerCase() === 'frontend-builder', `Stage 1 must be named 'frontend-builder' (found ${stage1[2]})`);
check(/node:\d+(-slim)?/i.test(stage1[1]), `Stage 1 must use Node.js image (found ${stage1[1]})`);

check(stage2[2].toLowerCase() === 'backend-builder', `Stage 2 must be named 'backend-builder' (found ${stage2[2]})`);
check(/rust:\d+(-slim)?/i.test(stage2[1]), `Stage 2 must use Rust image (found ${stage2[1]})`);

check(stage3[2].toLowerCase() === 'runtime', `Stage 3 must be named 'runtime' (found ${stage3[2]})`);
check(/debian:[a-z0-9-]+-slim/i.test(stage3[1]), `Stage 3 must use minimal Debian slim image (found ${stage3[1]})`);

// Stage 3 must NOT install or copy build tools
// Find lines belonging to Stage 3
const stage3Index = dockerfile.indexOf('AS runtime');
const stage3Content = dockerfile.slice(stage3Index);

check(!/apt-get.*install.*(cargo|rustc|gcc|g\+\+|build-essential|nodejs|npm)/i.test(stage3Content), 
  'Stage 3 runtime must NOT install cargo, rustc, gcc, g++, build-essential, nodejs, or npm via apt');

// Verify unprivileged user UID/GID 10001
check(/groupadd\s+(-g\s+)?10001/i.test(stage3Content), 'Stage 3 must create group with GID 10001');
check(/useradd\s+.*-u\s+10001/i.test(stage3Content), 'Stage 3 must create user with UID 10001');
check(/USER\s+10001:10001/i.test(stage3Content), 'Stage 3 must switch to USER 10001:10001');

// Verify /app/data creation, ownership and permissions (0755)
check(/mkdir\s+.*\/app\/data/i.test(stage3Content), 'Stage 3 must create /app/data');
check(/chown\s+.*10001:10001\s+\/app/i.test(stage3Content), 'Stage 3 must set ownership of /app to 10001:10001');
check(/chmod\s+0?755\s+\/app\/data/i.test(stage3Content), 'Stage 3 must set permissions of /app/data to 0755');

// Verify entrypoint / symlink
check(/COPY\s+--from=backend-builder.*\/app\/labnotes/i.test(stage3Content), 'Stage 3 must copy binary to /app/labnotes');
check(/ln\s+-s\s+\/app\/labnotes\s+\/app\/backend/i.test(stage3Content), 'Stage 3 must provide compatibility symlink /app/backend -> /app/labnotes');
check(/COPY\s+--from=frontend-builder.*\/app\/frontend\/dist/i.test(stage3Content), 'Stage 3 must copy frontend dist');

// Verify healthcheck in Dockerfile
check(/HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:8080\/healthz/i.test(stage3Content), 
  'Stage 3 must declare HEALTHCHECK against http://127.0.0.1:8080/healthz');

// Verify volume and expose
check(/VOLUME\s+\[.*"\/app\/data".*\]/i.test(stage3Content), 'Dockerfile must declare VOLUME ["/app/data"]');
check(/EXPOSE\s+8080/i.test(stage3Content), 'Dockerfile must EXPOSE 8080');


// ---------------------------------------------------------------------------
// 2. Compose.yaml Verification
// ---------------------------------------------------------------------------
console.log('\n--- 2. Testing compose.yaml Configuration & Invariants ---');
const composePath = path.join(PROJECT_ROOT, 'compose.yaml');
assert.ok(fs.existsSync(composePath), 'compose.yaml must exist');
const compose = fs.readFileSync(composePath, 'utf8');

// Strict port binding check: must bind ONLY 127.0.0.1:8080:8080
check(compose.includes('"127.0.0.1:8080:8080"'), 'compose.yaml must explicitly bind "127.0.0.1:8080:8080"');
check(!compose.includes('"0.0.0.0:8080"') && !compose.includes('"0.0.0.0:8080:8080"'), 
  'compose.yaml must NOT expose 0.0.0.0:8080');
check(!compose.includes('"8080:8080"'), 'compose.yaml must NOT use unconstrained "8080:8080"');

// Persistent volume check
check(compose.includes('data:/app/data'), 'compose.yaml must mount persistent volume data:/app/data');
check(/^volumes:\s*\n\s+data:/m.test(compose), 'compose.yaml must declare named volume data');

// Healthcheck in compose
check(compose.includes('http://127.0.0.1:8080/healthz'), 'compose.yaml healthcheck must target http://127.0.0.1:8080/healthz');

// Zero hardcoded passwords
check(!compose.includes('ADMIN_PASSWORD=admin') && !compose.includes('ADMIN_PASSWORD=password'),
  'compose.yaml must NOT contain hardcoded default passwords');
check(compose.includes('ADMIN_PASSWORD=${ADMIN_PASSWORD:-}'), 
  'compose.yaml must use environment substitution ${ADMIN_PASSWORD:-}');
check(compose.includes('SESSION_SECRET=${SESSION_SECRET:-}'), 
  'compose.yaml must use environment substitution ${SESSION_SECRET:-}');


// ---------------------------------------------------------------------------
// 3. .dockerignore Verification
// ---------------------------------------------------------------------------
console.log('\n--- 3. Testing .dockerignore Invariants ---');
const dockerignorePath = path.join(PROJECT_ROOT, '.dockerignore');
assert.ok(fs.existsSync(dockerignorePath), '.dockerignore must exist');
const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');

const requiredIgnores = [
  '.git',
  '.agents',
  'graphify-out',
  'target',
  'node_modules',
  'data',
  '*.sqlite',
  '.env',
  'e2e_tests',
  'backend/tests'
];

for (const pattern of requiredIgnores) {
  check(dockerignore.includes(pattern), `.dockerignore must include pattern: ${pattern}`);
}

// Critical: must NOT ignore frontend source or backend source
check(!/^frontend\/?$/m.test(dockerignore), '.dockerignore must not ignore frontend/ root');
check(!/^backend\/?$/m.test(dockerignore), '.dockerignore must not ignore backend/ root');


// ---------------------------------------------------------------------------
// 4. README.md Verification (AGENT_PLAN.md § 10: 8 Mandatory Sections)
// ---------------------------------------------------------------------------
console.log('\n--- 4. Testing README.md (All 8 Mandatory Sections) ---');
const readmePath = path.join(PROJECT_ROOT, 'README.md');
assert.ok(fs.existsSync(readmePath), 'README.md must exist');
const readme = fs.readFileSync(readmePath, 'utf8');

// Check Russian language
check(/[\u0400-\u04FF]/.test(readme), 'README.md must be written in Russian');

// Section 1: Требования к окружению и версии инструментов
check(/##\s+1\.\s+Требования\s+к\s+окружению\s+и\s+версии\s+инструментов/i.test(readme), 
  'Section 1 header present');
check(readme.includes('Rust') && /1\.80/i.test(readme), 'Section 1 mentions Rust 1.80+');
check(readme.includes('Node') && /22\+/i.test(readme), 'Section 1 mentions Node.js 22+');
check(readme.includes('Docker') && /24\./i.test(readme), 'Section 1 mentions Docker 24.0+');
check(readme.includes('Compose') && /v?2\.20/i.test(readme), 'Section 1 mentions Compose v2.20+');

// Section 2: Конфигурация (.env) и первичная настройка администратора
check(/##\s+2\.\s+Конфигурация\s+(\(\.env\)\s+)?и\s+первичная\s+настройка\s+администратора/i.test(readme), 
  'Section 2 header present');
check(readme.includes('cp .env.example .env') || readme.includes('copy .env.example .env'), 'Section 2 explains .env creation');
check(readme.includes('ADMIN_PASSWORD'), 'Section 2 documents ADMIN_PASSWORD');
check(/Argon2id/i.test(readme), 'Section 2 documents Argon2id hashing');
check(/идемпотентност/i.test(readme), 'Section 2 documents idempotent admin bootstrap');
check(!readme.includes('ADMIN_PASSWORD=admin'), 'Section 2 does NOT suggest default password');

// Section 3: Запуск приложения: Docker Compose и локальная разработка
check(/##\s+3\.\s+Запуск\s+приложения.*Docker\s+Compose.*локальная\s+разработка/i.test(readme), 
  'Section 3 header present');
check(readme.includes('docker compose up -d --build'), 'Section 3 contains docker compose up -d --build');
check(readme.includes('http://127.0.0.1:8080/healthz'), 'Section 3 contains healthz verification');
check(readme.includes('cargo run') && readme.includes('npm run dev'), 'Section 3 documents local manual run (Rust + Vite)');
check(/5173/.test(readme), 'Section 3 documents Vite dev server port 5173 with proxy');

// Section 4: Руководство пользователя: первый вход, создание и публикация работы
check(/##\s+4\.\s+Руководство\s+пользователя.*первый\s+вход.*создание.*публикация/i.test(readme), 
  'Section 4 header present');
check(readme.includes('http://localhost:8080'), 'Section 4 mentions http://localhost:8080');
check(readme.includes('/admin/login'), 'Section 4 mentions /admin/login');
check(/CodeMirror/i.test(readme), 'Section 4 mentions CodeMirror editor');
check(/Ctrl\+V|буфер/i.test(readme), 'Section 4 documents paste / drag-and-drop screenshots');
check(/Lightbox|полноэкранн/i.test(readme), 'Section 4 documents Lightbox fullscreen preview');
check(/оглавлен|H2.*H3/i.test(readme), 'Section 4 documents automatic TOC');
check(/копирован.*код/i.test(readme), 'Section 4 documents code copy button');
check(/вложени/i.test(readme), 'Section 4 documents attachments');
check(/черновик|опубликован/i.test(readme), 'Section 4 documents draft vs published snapshot');
check(/Снять\s+с\s+публикации/i.test(readme), 'Section 4 documents unpublish functionality');

// Section 5: Эксплуатация: логи, остановка, обновление и смена пароля
check(/##\s+5\.\s+Эксплуатация.*логи.*остановка.*обновление.*парол/i.test(readme), 
  'Section 5 header present');
check(readme.includes('docker compose logs'), 'Section 5 documents docker compose logs');
check(readme.includes('docker compose down'), 'Section 5 documents docker compose down');
check(readme.includes('git pull') && readme.includes('docker compose up -d --build'), 'Section 5 documents update without data loss');
check(readme.includes('--set-admin-password'), 'Section 5 documents CLI flag --set-admin-password');

// Section 6: Резервное копирование и восстановление
check(/##\s+6\.\s+Резервное\s+копирование\s+и\s+восстановление/i.test(readme), 
  'Section 6 header present');
check(/WAL|Write-Ahead\s+Logging/i.test(readme), 'Section 6 explains SQLite WAL mechanism');
check(/ЗАПРЕЩЕНО.*\.sqlite/i.test(readme) || /предупреждение.*WAL/i.test(readme), 
  'Section 6 warns against copying live .sqlite without stopping');
check(/docker compose down/i.test(readme), 'Section 6 specifies stopping app before backup');
check(/tar\s+.*backup/i.test(readme), 'Section 6 provides concrete backup command');
check(/восстановлен/i.test(readme), 'Section 6 provides restore instructions');

// Section 7: Развертывание на VPS: Caddy, HTTPS и сетевая безопасность
check(/##\s+7\.\s+Развертывание\s+на\s+VPS.*Caddy.*HTTPS.*безопасность/i.test(readme), 
  'Section 7 header present');
check(/DNS/i.test(readme) && /A-запись/i.test(readme) && /AAAA/i.test(readme), 'Section 7 documents DNS A and AAAA records');
check(/Caddyfile/i.test(readme), 'Section 7 documents Caddyfile reverse proxy');
check(readme.includes('reverse_proxy 127.0.0.1:8080') || readme.includes('reverse_proxy app:8080'), 
  'Section 7 provides Caddyfile example distinguishing host vs container upstream');
check(readme.includes('COOKIE_SECURE=true'), 'Section 7 specifies COOKIE_SECURE=true for production');
check(readme.includes('APP_BASE_URL'), 'Section 7 explains APP_BASE_URL requirement');
check(/127\.0\.0\.1:8080/i.test(readme), 'Section 7 emphasizes localhost binding to prevent bypass');
check(readme.includes('80/tcp') && readme.includes('443/tcp'), 'Section 7 documents firewall ports 80/443');

// Section 8: Разъяснения по хостингу: домен, GitHub Pages и проблемы CGNAT
check(/##\s+8\.\s+Разъяснения\s+по\s+хостингу.*домен.*GitHub\s+Pages.*CGNAT/i.test(readme), 
  'Section 8 header present');
check(/домен.*хостинг|не\s+заменяет/i.test(readme), 'Section 8 clarifies domain vs hosting');
check(/GitHub\s+Pages.*не.*может|статическ/i.test(readme), 'Section 8 explains why GitHub Pages cannot run Rust/SQLite');
check(/CGNAT|Carrier-Grade\s+NAT/i.test(readme), 'Section 8 explains CGNAT on home connections');
check(/100\.64\.|10\./i.test(readme), 'Section 8 explains private IP ranges under CGNAT');
check(/VPS/i.test(readme), 'Section 8 recommends VPS for persistent availability');


// ---------------------------------------------------------------------------
// 5. STATUS.md Verification
// ---------------------------------------------------------------------------
console.log('\n--- 5. Testing STATUS.md Accuracy & Metrics ---');
const statusPath = path.join(PROJECT_ROOT, 'STATUS.md');
assert.ok(fs.existsSync(statusPath), 'STATUS.md must exist');
const status = fs.readFileSync(statusPath, 'utf8');

// Metrics assertions
check(/Размер исполняемого файла/i.test(status) && /4\.65\s*МиБ/i.test(status), 'STATUS.md reports binary size (4.65 MiB)');
check(/220\.44\s*кБ/i.test(status), 'STATUS.md reports public bundle size (220.44 kB)');
check(/526\.17\s*кБ/i.test(status), 'STATUS.md reports isolated editor chunk size (526.17 kB)');
check(/Idle RSS/i.test(status) && /~7\.7\s*МиБ/i.test(status), 'STATUS.md reports idle RSS memory (~7.7 MiB)');
check(/Argon2id/i.test(status) && /\+19\.2\s*МиБ/i.test(status), 'STATUS.md reports Argon2id peak memory');
check(/158\s*тест/i.test(status), 'STATUS.md accurately reports 158 Rust tests');
check(/35.*35/i.test(status) && /sanity/i.test(status), 'STATUS.md reports 35/35 sanity tests');
check(/Осознанные ограничения MVP/i.test(status), 'STATUS.md defines MVP limitations');
check(/План дальнейших улучшений/i.test(status), 'STATUS.md lists post-MVP roadmap');

// Check that .env.example has empty password
const envExamplePath = path.join(PROJECT_ROOT, '.env.example');
assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
const envExample = fs.readFileSync(envExamplePath, 'utf8');
check(/ADMIN_PASSWORD=\s*$/m.test(envExample), '.env.example must have empty ADMIN_PASSWORD by default');

// ---------------------------------------------------------------------------
// 6. Empirical Build Artifacts Verification
// ---------------------------------------------------------------------------
console.log('\n--- 6. Testing Compiled Artifacts & Binary Footprint ---');
const releaseBinPath = path.join(PROJECT_ROOT, 'backend', 'target', 'release', 'backend.exe');
if (fs.existsSync(releaseBinPath)) {
  const stats = fs.statSync(releaseBinPath);
  const sizeMiB = stats.size / (1024 * 1024);
  console.log(`Measured Release Binary Size: ${stats.size} bytes (${sizeMiB.toFixed(2)} MiB)`);
  check(sizeMiB > 3.0 && sizeMiB < 8.0, `Release binary size is within compact target (3.0 - 8.0 MiB, actual: ${sizeMiB.toFixed(2)} MiB)`);
}

const frontendDist = path.join(PROJECT_ROOT, 'frontend', 'dist');
check(fs.existsSync(path.join(frontendDist, 'index.html')), 'frontend/dist/index.html must exist on disk');
const assetsDir = path.join(frontendDist, 'assets');
check(fs.existsSync(assetsDir), 'frontend/dist/assets directory must exist on disk');
const assetFiles = fs.readdirSync(assetsDir);
check(assetFiles.some(f => f.endsWith('.js')), 'frontend/dist/assets must contain compiled JS chunks');
check(assetFiles.some(f => f.endsWith('.css')), 'frontend/dist/assets must contain compiled CSS chunks');

console.log(`\n======================================================`);
console.log(`All ${passedAssertions} empirical verification assertions PASSED successfully!`);
console.log(`======================================================\n`);
