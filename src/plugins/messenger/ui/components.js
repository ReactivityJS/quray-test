// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/components.js
// registerMessengerComponents() — registers all qm-* custom elements.
//
// Call this AFTER registerComponents() from src/ui/components.js,
// as the messenger components depend on qu-chat-msg, qu-avatar, qu-status,
// qu-emoji-picker, qu-blob-drop, etc. being registered first.
//
// Usage:
//   import { registerComponents }         from '../../ui/components.js'
//   import { registerMessengerComponents } from './components.js'
//
//   registerComponents(db, { me, peers, net })
//   registerMessengerComponents()
// ════════════════════════════════════════════════════════════════════════════

import { QmApp }         from './qm-app.js'
import { QmSidebar }     from './qm-sidebar.js'
import { QmChat }        from './qm-chat.js'
import { QmComposer }    from './qm-composer.js'
import { QmCallOverlay } from './qm-call.js'


/**
 * Register all Messenger custom elements.
 * Safe to call multiple times — skips already-registered elements.
 */
const registerMessengerComponents = () => {
  if (!customElements.get('qm-app'))          customElements.define('qm-app',          QmApp)
  if (!customElements.get('qm-sidebar'))       customElements.define('qm-sidebar',       QmSidebar)
  if (!customElements.get('qm-chat'))          customElements.define('qm-chat',          QmChat)
  if (!customElements.get('qm-composer'))      customElements.define('qm-composer',      QmComposer)
  if (!customElements.get('qm-call-overlay'))  customElements.define('qm-call-overlay',  QmCallOverlay)
}


export {
  registerMessengerComponents,
  QmApp,
  QmSidebar,
  QmChat,
  QmComposer,
  QmCallOverlay,
}
