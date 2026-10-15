import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // SvelteKit convention is the PUBLIC_ prefix; include it so
  // import.meta.env.PUBLIC_APPWRITE_* is baked into client builds.
  envPrefix: ['PUBLIC_', 'VITE_'],
});
