import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Ship font files with the app instead of relying on system packages installed
// only in Docker images. Render's native Node runtime can use these paths too.
export const DEJAVU_REGULAR = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
export const DEJAVU_BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
