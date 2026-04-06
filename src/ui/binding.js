// QuRay — ui/binding.js
// Native qu-* attribute bindings for plain HTML elements.
//
// Why this module exists:
//   - simple inline bindings should not require wrapper elements
//   - transient DOM nodes must clean up their listeners automatically
//   - the implementation should stay small, explicit and easy to debug
//
// Supported attributes:
//   qu-key="~/alias"                 exact storage key or shorthand reference
//   qu-get="val|data.name|ts|..."    value path inside the QuBit (default: val)
//   qu-bind="text|html|value|attr:title|prop:checked"
//   qu-mode="one-way|two-way"        default: one-way
//   qu-live                           save on every input instead of change
//   qu-format="text|count|date|..."
//   qu-placeholder="–" qu-prefix="" qu-suffix=""
//   qu-scope="data|blob|delivery"    optional, normally inferred from the key
//
// Examples:
//   <span qu-key="~/alias"></span>
//   <input qu-key="conf/app/title" qu-bind="value" qu-mode="two-way">
//   <title qu-key="conf/app/title"></title>

import { resolveStorageKeyReference } from '../core/qubit.js'
import {
  applyTemplateBindingValue,
  cloneSerializableValue,
  extractValueFromDataRecord,
  readNestedValue,
  writeNestedValue,
} from './value-binding.js'

const NATIVE_BINDING_ATTRIBUTE_NAMES = [
  'qu-key',
  'qu-get',
  'qu-bind',
  'qu-mode',
  'qu-live',
  'qu-format',
  'qu-placeholder',
  'qu-prefix',
  'qu-suffix',
  'qu-scope',
]

function inferBindingTargetName(elementNode) {
  const tagName = elementNode.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'option') return 'value'
  return 'text'
}

function inferBindingScopeName(keyReference, explicitScopeName = null) {
  if (explicitScopeName) return explicitScopeName
  if (typeof keyReference !== 'string') return 'data'
  if (keyReference.startsWith('conf/delivery/')) return 'delivery'
  if (keyReference.startsWith('blobs/')) return 'blob'
  return 'data'
}

function inferDefaultValuePath(scopeName) {
  if (scopeName === 'blob') return 'status'
  if (scopeName === 'delivery') return 'state'
  return 'val'
}

function canUseTwoWayBinding(elementNode, targetBinding) {
  if (targetBinding === 'value') {
    const tagName = elementNode.tagName.toLowerCase()
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
  }
  if (targetBinding === 'text' || targetBinding === 'html') return elementNode.isContentEditable === true
  if (targetBinding.startsWith('prop:')) return true
  return false
}

function readElementBoundValue(elementNode, targetBinding) {
  if (targetBinding === 'value') return elementNode.value
  if (targetBinding === 'html') return elementNode.innerHTML
  if (targetBinding === 'text') return elementNode.textContent
  if (targetBinding === 'prop:checked') return Boolean(elementNode.checked)
  if (targetBinding.startsWith('prop:')) return elementNode[targetBinding.slice(5)]
  return elementNode.textContent
}

function extractScopedValue(sourceRecord, valuePath, scopeName) {
  if (sourceRecord == null) return null
  if (scopeName === 'data') return extractValueFromDataRecord(sourceRecord, valuePath)
  if (!valuePath || valuePath === 'value') return sourceRecord
  if (valuePath === 'status' && sourceRecord?.status !== undefined) return sourceRecord.status
  if (valuePath === 'state' && sourceRecord?.state !== undefined) return sourceRecord.state
  return readNestedValue(sourceRecord, valuePath)
}

function buildWriteValue(sourceQuBit, valuePath, nextValue) {
  if (valuePath === 'val' || valuePath === 'data' || valuePath === 'value') return nextValue

  const currentDataValue = cloneSerializableValue(sourceQuBit?.data ?? {}) ?? {}
  if (valuePath.startsWith('data.')) {
    writeNestedValue(currentDataValue, valuePath.slice(5), nextValue)
    return currentDataValue
  }

  writeNestedValue(currentDataValue, valuePath, nextValue)
  return currentDataValue
}

function isNativeBindingElement(elementNode) {
  return elementNode instanceof Element
    && elementNode.hasAttribute('qu-key')
    && elementNode.tagName.toLowerCase() !== 'qu-bind'
    && elementNode.tagName.toLowerCase() !== 'qu-list'
}

function collectNativeBindingElements(rootNode) {
  const collectedElements = []
  if (isNativeBindingElement(rootNode)) collectedElements.push(rootNode)
  if (!(rootNode instanceof Element || rootNode instanceof Document || rootNode instanceof DocumentFragment)) return collectedElements
  rootNode.querySelectorAll?.('[qu-key]').forEach((elementNode) => {
    if (isNativeBindingElement(elementNode)) collectedElements.push(elementNode)
  })
  return collectedElements
}

class QuContext extends HTMLElement {}

function QuBinding(database, options = {}) {
  const activeBindingHandles = new Set()
  const bindingHandleByElement = new WeakMap()
  let mutationObserver = null

  const getCurrentUserPublicKey = options.getCurrentUserPublicKey ?? (() => options.currentUserPublicKey ?? null)

  function readBindingDescriptor(elementNode) {
    const keyReference = elementNode.getAttribute('qu-key')
    const scopeName = inferBindingScopeName(keyReference, elementNode.getAttribute('qu-scope'))
    const valuePath = elementNode.getAttribute('qu-get') || inferDefaultValuePath(scopeName)

    return {
      keyReference,
      resolvedKeyReference: resolveStorageKeyReference(keyReference, {
        currentUserPublicKey: getCurrentUserPublicKey?.() ?? null,
      }),
      scopeName,
      valuePath,
      targetBinding: elementNode.getAttribute('qu-bind') || inferBindingTargetName(elementNode),
      bindingMode: elementNode.getAttribute('qu-mode') || 'one-way',
      liveUpdates: elementNode.hasAttribute('qu-live'),
      formatName: elementNode.getAttribute('qu-format') || 'text',
      placeholderText: elementNode.getAttribute('qu-placeholder') || '–',
      prefixText: elementNode.getAttribute('qu-prefix') || '',
      suffixText: elementNode.getAttribute('qu-suffix') || '',
    }
  }

  function disposeBindingHandle(bindingHandle) {
    if (!bindingHandle || bindingHandle.disposed) return
    bindingHandle.disposed = true
    activeBindingHandles.delete(bindingHandle)
    bindingHandle.cleanupFunctions.forEach((cleanupFunction) => {
      try { cleanupFunction?.() } catch {}
    })
    bindingHandle.cleanupFunctions = []
  }

  function unbindElement(elementNode) {
    const existingBindingHandle = bindingHandleByElement.get(elementNode)
    if (!existingBindingHandle) return
    disposeBindingHandle(existingBindingHandle)
    bindingHandleByElement.delete(elementNode)
  }

  function cleanupDisconnectedBindingHandles() {
    for (const bindingHandle of [...activeBindingHandles]) {
      if (bindingHandle.elementNode?.isConnected) continue
      disposeBindingHandle(bindingHandle)
      bindingHandleByElement.delete(bindingHandle.elementNode)
    }
  }

  function applyRecordToElement(elementNode, bindingDescriptor, sourceRecord) {
    const resolvedValue = extractScopedValue(sourceRecord, bindingDescriptor.valuePath, bindingDescriptor.scopeName)
    applyTemplateBindingValue(elementNode, resolvedValue, {
      targetBinding: bindingDescriptor.targetBinding,
      formatName: bindingDescriptor.formatName,
      placeholderText: bindingDescriptor.placeholderText,
      prefixText: bindingDescriptor.prefixText,
      suffixText: bindingDescriptor.suffixText,
    })
  }

  async function writeElementValueToDatabase(bindingHandle) {
    const { elementNode, bindingDescriptor } = bindingHandle
    if (!elementNode.isConnected || bindingDescriptor.scopeName !== 'data') return

    const nextRawValue = readElementBoundValue(elementNode, bindingDescriptor.targetBinding)
    if (bindingDescriptor.valuePath === 'val' || bindingDescriptor.valuePath === 'data' || bindingDescriptor.valuePath === 'value') {
      await database.put(bindingDescriptor.resolvedKeyReference, nextRawValue)
      return
    }

    const currentQuBit = await database.get(bindingDescriptor.resolvedKeyReference)
    const nextStoredValue = buildWriteValue(currentQuBit, bindingDescriptor.valuePath, nextRawValue)
    await database.put(bindingDescriptor.resolvedKeyReference, nextStoredValue)
  }

  function attachTwoWayBinding(bindingHandle) {
    // Two-way DOM events are handled centrally through delegated listeners.
    // This keeps transient nodes safe even when they are added and edited
    // before the MutationObserver has attached a per-element handle.
    return bindingHandle
  }

  function bindElement(elementNode) {
    unbindElement(elementNode)

    const bindingDescriptor = readBindingDescriptor(elementNode)
    if (!bindingDescriptor.resolvedKeyReference) return null

    const bindingHandle = {
      elementNode,
      bindingDescriptor,
      cleanupFunctions: [],
      disposed: false,
    }

    const applyIncomingRecord = (sourceRecord) => {
      if (bindingHandle.disposed) return
      if (!elementNode.isConnected) {
        disposeBindingHandle(bindingHandle)
        return
      }
      applyRecordToElement(elementNode, bindingDescriptor, sourceRecord)
    }

    if (bindingDescriptor.scopeName === 'delivery') {
      const deliveryKey = bindingDescriptor.resolvedKeyReference.replace(/^conf\/delivery\//u, '').replace(/_/gu, '/')
      database.delivery?.get(deliveryKey).then((entry) => applyIncomingRecord(entry)).catch(() => {})
      const stopListening = database.delivery?.on(deliveryKey, (entry) => applyIncomingRecord(entry))
      if (stopListening) bindingHandle.cleanupFunctions.push(stopListening)
    } else {
      const stopListening = database.on(bindingDescriptor.resolvedKeyReference, (sourceRecord) => {
        applyIncomingRecord(sourceRecord)
      }, {
        scope: bindingDescriptor.scopeName,
        immediate: true,
      })
      if (stopListening) bindingHandle.cleanupFunctions.push(stopListening)
    }

    attachTwoWayBinding(bindingHandle)

    activeBindingHandles.add(bindingHandle)
    bindingHandleByElement.set(elementNode, bindingHandle)
    return bindingHandle
  }

  function bindTree(rootNode) {
    collectNativeBindingElements(rootNode).forEach((elementNode) => bindElement(elementNode))
  }

  function unbindTree(rootNode) {
    collectNativeBindingElements(rootNode).forEach((elementNode) => unbindElement(elementNode))
    if (isNativeBindingElement(rootNode)) unbindElement(rootNode)
  }

  function handleMutationRecords(mutationRecords) {
    for (const mutationRecord of mutationRecords) {
      if (mutationRecord.type === 'childList') {
        mutationRecord.addedNodes.forEach((addedNode) => bindTree(addedNode))
        mutationRecord.removedNodes.forEach((removedNode) => unbindTree(removedNode))
      }

      if (mutationRecord.type === 'attributes') {
        const elementNode = mutationRecord.target
        if (isNativeBindingElement(elementNode)) bindElement(elementNode)
        else unbindElement(elementNode)
      }
    }
    cleanupDisconnectedBindingHandles()
  }

  function getElementBindingHandle(elementNode) {
    if (!elementNode || !isNativeBindingElement(elementNode)) return null
    let bindingHandle = bindingHandleByElement.get(elementNode) ?? null
    if (!bindingHandle) bindingHandle = bindElement(elementNode)
    return bindingHandle ?? null
  }

  function handleDelegatedWriteEvent(domEvent) {
    const eventTargetNode = domEvent.target instanceof Element ? domEvent.target : null
    const boundElementNode = eventTargetNode?.closest?.('[qu-key]') ?? null
    if (!boundElementNode || !isNativeBindingElement(boundElementNode)) return

    const bindingHandle = getElementBindingHandle(boundElementNode)
    if (!bindingHandle) return

    const { bindingDescriptor } = bindingHandle
    if (bindingDescriptor.bindingMode !== 'two-way') return
    if (!canUseTwoWayBinding(boundElementNode, bindingDescriptor.targetBinding)) return
    if (domEvent.type === 'input' && !bindingDescriptor.liveUpdates) return
    if (domEvent.type === 'change' && bindingDescriptor.liveUpdates) return

    writeElementValueToDatabase(bindingHandle).catch((error) => {
      /*DEBUG*/ console.warn('[QuRay:Binding] delegated write failed', bindingDescriptor.resolvedKeyReference, error?.message)
    })
  }

  function init() {
    if (mutationObserver) return api
    bindTree(document.documentElement)
    document.addEventListener('input', handleDelegatedWriteEvent, true)
    document.addEventListener('change', handleDelegatedWriteEvent, true)
    mutationObserver = new MutationObserver(handleMutationRecords)
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: NATIVE_BINDING_ATTRIBUTE_NAMES,
    })
    cleanupDisconnectedBindingHandles()
    return api
  }

  function refresh(rootNode = document.documentElement) {
    bindTree(rootNode)
    return api
  }

  function destroy() {
    mutationObserver?.disconnect()
    mutationObserver = null
    document.removeEventListener('input', handleDelegatedWriteEvent, true)
    document.removeEventListener('change', handleDelegatedWriteEvent, true)
    for (const bindingHandle of [...activeBindingHandles]) disposeBindingHandle(bindingHandle)
  }

  function getStats() {
    cleanupDisconnectedBindingHandles()
    return {
      nativeBindingCount: activeBindingHandles.size,
    }
  }

  const api = {
    init,
    refresh,
    destroy,
    bindElement,
    unbindElement,
    getStats,
  }

  return api
}

function registerBindingComponents() {
  if (!customElements.get('qu-context')) customElements.define('qu-context', QuContext)
}

export {
  QuBinding,
  QuContext,
  registerBindingComponents,
  buildWriteValue,
  extractScopedValue,
  inferBindingScopeName,
  inferBindingTargetName,
  canUseTwoWayBinding,
  NATIVE_BINDING_ATTRIBUTE_NAMES,
}
