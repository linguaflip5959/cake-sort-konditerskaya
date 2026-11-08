import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html', // сортировка «Кондитерская»
      },
    },
  },
});
