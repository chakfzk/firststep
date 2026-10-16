import { defineConfig } from 'vite';

// GitHub Pages 등 하위 경로에서도 동작하도록 상대 경로로 빌드한다.
export default defineConfig({ base: './' });
