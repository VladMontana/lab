import { writable } from 'svelte/store';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  duration?: number;
}

function createToastStore() {
  const { subscribe, update } = writable<ToastMessage[]>([]);

  function show(message: string, type: ToastMessage['type'] = 'info', duration = 3000) {
    const id = Math.random().toString(36).substring(2, 9);
    const toastItem: ToastMessage = { id, type, message, duration };
    update((toasts) => [...toasts, toastItem]);

    if (duration > 0) {
      setTimeout(() => {
        dismiss(id);
      }, duration);
    }
    return id;
  }

  function dismiss(id: string) {
    update((toasts) => toasts.filter((t) => t.id !== id));
  }

  return {
    subscribe,
    show,
    success: (msg: string, duration?: number) => show(msg, 'success', duration),
    error: (msg: string, duration?: number) => show(msg, 'error', duration ?? 5000),
    warning: (msg: string, duration?: number) => show(msg, 'warning', duration ?? 4000),
    info: (msg: string, duration?: number) => show(msg, 'info', duration),
    dismiss,
  };
}

export const toast = createToastStore();
