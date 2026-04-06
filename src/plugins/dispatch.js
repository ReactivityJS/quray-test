// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/dispatch.js
// IN + OUT Pipeline: db.on() Events feuern nach Store.
//
// Signaling-Typen (peer.hello, peer.bye, webrtc.*) werden übersprungen —
// sie haben kein qubit.key und werden nie gespeichert.
// ════════════════════════════════════════════════════════════════════════════

import { PIPELINE_PRIORITY } from '../core/events.js'
import { NO_STORE_TYPES }    from '../core/qubit.js'


/**
 * Middleware plugin that fires db.on() reactive listeners after every write.
 * Runs in both IN pipeline (remote data) and OUT pipeline (local writes).
 * This is what makes db.on('~pub/**', fn) work reactively.
 *
 * @returns {PluginFactory}
 * @group Plugin
 * @since 0.1.0
 */
const DispatchPlugin = () => (db) => {

  // IN: eingehende QuBits dispatchen (nach STORE_IN)
  const offInFn = db.useIn(async ({ args: [pipelineContext], next }) => {
    const { qubit, previous = null } = pipelineContext

    // Signaling-Typen haben kein key → EventBus würde auf undefined.split() crashen
    if (!qubit?.key || NO_STORE_TYPES.has(qubit.type)) {
      await next()
      return
    }

    const eventName = qubit.deleted ? 'del' : 'put'
    await db._internal.bus.emit(qubit.key, qubit, {
      event: eventName,
      key: qubit.key,
      source: 'remote',
      scope: 'data',
      current: qubit,
      previous,
    })
    /*DEBUG*/ console.debug('[QuRay:DispatchPlugin] IN:', qubit.type, qubit.key?.slice(0, 40))
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_IN)


  // OUT: ausgehende QuBits dispatchen (nach STORE_OUT)
  const offOutFn = db.useOut(async ({ args: [pipelineContext], next }) => {
    const { qubit, previous = null } = pipelineContext

    if (!qubit?.key || NO_STORE_TYPES.has(qubit.type)) {
      await next()
      return
    }

    const dispatchQuBit = { ...qubit, _mine: true }
    const eventName = qubit.deleted ? 'del' : 'put'
    await db._internal.bus.emit(qubit.key, dispatchQuBit, {
      event: eventName,
      key: qubit.key,
      source: 'local',
      scope: 'data',
      current: dispatchQuBit,
      previous,
    })
    /*DEBUG*/ console.debug('[QuRay:DispatchPlugin] OUT:', qubit.type, qubit.key?.slice(0, 40))
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_OUT)


  return () => { offInFn(); offOutFn() }
}


export { DispatchPlugin }
