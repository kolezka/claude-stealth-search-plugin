// DeepSeek Harness entry for this Claude Code plugin. The plugin tree is read as is.
// claude-compat.js is vendored from @kolezka/claude-plugins-dsh: refresh it with `sync`, do not edit it.
import { createPlugin, rootFrom } from './claude-compat.js'

const plugin = createPlugin({ root: rootFrom(import.meta.url) })
export const { name, apply } = plugin
export default plugin
