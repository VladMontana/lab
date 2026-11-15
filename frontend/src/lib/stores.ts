/**
 * Svelte Stores for LabNotes MVP.
 * Auth state, cached subjects, and UI state (e.g. mobile drawer).
 */

import { writable } from 'svelte/store';
import { api, type AdminUserDto, type PublicSubjectItem } from './api';

export interface AuthState {
  isAuthenticated: boolean;
  user: AdminUserDto | null;
  loading: boolean;
}

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthState>({
    isAuthenticated: false,
    user: null,
    loading: true,
  });

  return {
    subscribe,
    set,
    update,
    async init() {
      try {
        const me = await api.getMe();
        if (me) {
          set({
            isAuthenticated: true,
            user: { id: me.id, username: me.username },
            loading: false,
          });
        } else {
          set({ isAuthenticated: false, user: null, loading: false });
        }
      } catch {
        set({ isAuthenticated: false, user: null, loading: false });
      }
    },
    loginSuccess(user: AdminUserDto) {
      set({
        isAuthenticated: true,
        user,
        loading: false,
      });
    },
    async logout() {
      try {
        await api.logout();
      } finally {
        set({
          isAuthenticated: false,
          user: null,
          loading: false,
        });
      }
    },
  };
}

export const auth = createAuthStore();

function createSubjectsStore() {
  const { subscribe, set } = writable<PublicSubjectItem[]>([]);

  return {
    subscribe,
    set,
    async load() {
      try {
        const list = await api.getPublicSubjects();
        set(list);
      } catch (err) {
        console.error('Failed to load public subjects:', err);
      }
    },
  };
}

export const subjects = createSubjectsStore();

export const mobileSidebarOpen = writable<boolean>(false);
