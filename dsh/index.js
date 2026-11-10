// DeepSeek Harness entry for this Claude Code plugin. The plugin tree is read as is.
import { createPlugin, rootFrom } from 'claude-plugin-dsh'

const plugin = createPlugin({ root: rootFrom(import.meta.url) })
export const { name, apply } = plugin
export default plugin
