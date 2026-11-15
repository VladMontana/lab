<script lang="ts">
  import { api, ApiClientError } from '../lib/api';
  import { auth } from '../lib/stores';
  import { router } from '../lib/router';

  let username = $state<string>('');
  let password = $state<string>('');
  let submitting = $state<boolean>(false);
  let errorMessage = $state<string | null>(null);
  let errorType = $state<'error' | 'warning'>('error');

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!username.trim() || !password) {
      errorMessage = 'Пожалуйста, введите логин и пароль.';
      errorType = 'error';
      return;
    }

    submitting = true;
    errorMessage = null;

    try {
      const res = await api.login({
        username: username.trim(),
        password,
      });

      auth.loginSuccess(res.user);
      router.navigate('/');
    } catch (err: any) {
      if (err instanceof ApiClientError) {
        if (err.isRateLimited()) {
          const waitSec = err.retryAfter ? ` через ${err.retryAfter} сек.` : '';
          errorMessage = `Слишком много неудачных попыток входа. Пожалуйста, повторите попытку${waitSec}`;
          errorType = 'warning';
        } else if (err.isUnauthorized()) {
          errorMessage = 'Неверное имя пользователя или пароль.';
          errorType = 'error';
        } else {
          errorMessage = err.message || 'Ошибка авторизации.';
          errorType = 'error';
        }
      } else {
        errorMessage = err.message || 'Не удалось связаться с сервером.';
        errorType = 'error';
      }
    } finally {
      submitting = false;
    }
  }
</script>

<div class="login-container">
  <div class="login-card">
    <div class="login-card-header">
      <div class="login-icon">🔐</div>
      <h1 class="login-title">Вход для автора</h1>
      <p class="login-subtitle">Управление практическими работами и предметами</p>
    </div>

    {#if errorMessage}
      <div class="login-error-banner {errorType}" role="alert">
        {errorMessage}
      </div>
    {/if}

    <form class="login-form" onsubmit={handleSubmit}>
      <div class="form-group">
        <label for="username" class="form-label">Имя пользователя</label>
        <input
          id="username"
          type="text"
          class="form-input"
          placeholder="admin"
          bind:value={username}
          disabled={submitting}
          required
          autocomplete="username"
        />
      </div>

      <div class="form-group">
        <label for="password" class="form-label">Пароль</label>
        <input
          id="password"
          type="password"
          class="form-input"
          placeholder="••••••••"
          bind:value={password}
          disabled={submitting}
          required
          autocomplete="current-password"
        />
      </div>

      <button type="submit" class="login-submit-btn" disabled={submitting}>
        {#if submitting}
          Вход...
        {:else}
          Войти в систему
        {/if}
      </button>
    </form>

    <div class="login-footer-link">
      <a href="/">← Вернуться в каталог публикаций</a>
    </div>
  </div>
</div>
