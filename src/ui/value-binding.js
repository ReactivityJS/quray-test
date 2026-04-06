// QuRay — ui/value-binding.js
// Shared helpers for DOM value binding, formatting and native template rendering.
// This module intentionally contains only side-effect free utilities so it can be
// reused by both Custom Elements and the native qu-* attribute binding engine.

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu
const QUBIT_ROOT_FIELD_NAMES = new Set(['id', 'key', 'ts', 'from', 'type', 'sig', 'hash', 'enc', 'refs', 'order'])

function findInlineTemplateElement(hostElement) {
  return hostElement.querySelector(':scope > template') ?? hostElement.querySelector('template') ?? null
}

function cloneInlineTemplateElement(templateElement) {
  return templateElement ? templateElement.cloneNode(true) : null
}

function formatBindingValue(rawValue, formatName = 'text', placeholderText = '–') {
  if (rawValue === null || rawValue === undefined) return placeholderText
  const normalizedFormatName = formatName || 'text'
  switch (normalizedFormatName) {
    case 'date':
      return new Date(rawValue).toLocaleDateString('de', { day: '2-digit', month: '2-digit', year: 'numeric' })
    case 'time':
      return new Date(rawValue).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })
    case 'datetime':
      return new Date(rawValue).toLocaleString('de', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    case 'bytes':
      return rawValue < 1024
        ? `${rawValue} B`
        : rawValue < 1048576
          ? `${(rawValue / 1024).toFixed(1)} KB`
          : `${(rawValue / 1048576).toFixed(1)} MB`
    case 'count':
      return Number(rawValue).toLocaleString('de')
    case 'json':
      return JSON.stringify(rawValue, null, 2)
    case 'bool':
      return rawValue ? '✓' : '–'
    default:
      return String(rawValue)
  }
}

function readNestedValue(sourceValue, dotPath) {
  if (!dotPath) return sourceValue
  return dotPath.split('.').reduce((currentValue, pathSegment) => (
    currentValue != null && typeof currentValue === 'object' ? currentValue[pathSegment] : undefined
  ), sourceValue)
}

function writeNestedValue(targetValue, dotPath, nextValue) {
  if (!dotPath) return targetValue
  const pathSegments = dotPath.split('.')
  const lastSegment = pathSegments.pop()
  const targetObject = pathSegments.reduce((currentValue, pathSegment) => {
    if (currentValue[pathSegment] == null || typeof currentValue[pathSegment] !== 'object') currentValue[pathSegment] = {}
    return currentValue[pathSegment]
  }, targetValue)
  targetObject[lastSegment] = nextValue
  return targetValue
}

function createTemplateBindingContext(qubit, extractedValue, keyReference) {
  return {
    qubit,
    key: keyReference ?? qubit?.key ?? null,
    value: extractedValue,
    data: qubit?.data ?? null,
    current: qubit,
  }
}

function resolveTemplateBindingValue(templateContext, pathExpression) {
  const normalizedPathExpression = String(pathExpression ?? '').trim()
  if (!normalizedPathExpression) return templateContext.value
  if (normalizedPathExpression in templateContext) return templateContext[normalizedPathExpression]
  if (normalizedPathExpression === '.' || normalizedPathExpression === 'value') return templateContext.value
  if (normalizedPathExpression.startsWith('qubit.')) return readNestedValue(templateContext.qubit, normalizedPathExpression.slice(6))
  if (normalizedPathExpression.startsWith('data.')) return readNestedValue(templateContext.data, normalizedPathExpression.slice(5))
  if (QUBIT_ROOT_FIELD_NAMES.has(normalizedPathExpression)) return templateContext.qubit?.[normalizedPathExpression]
  if (templateContext.value && typeof templateContext.value === 'object') {
    const directValue = readNestedValue(templateContext.value, normalizedPathExpression)
    if (directValue !== undefined) return directValue
  }
  const dataValue = readNestedValue(templateContext.data, normalizedPathExpression)
  if (dataValue !== undefined) return dataValue
  return readNestedValue(templateContext.qubit, normalizedPathExpression)
}

function applyTemplateBindingValue(targetElement, rawValue, {
  targetBinding = 'text',
  formatName = 'text',
  placeholderText = '–',
  prefixText = '',
  suffixText = '',
} = {}) {
  const formattedValue = formatBindingValue(rawValue, formatName, placeholderText)
  const prefixedValue = `${prefixText}${formattedValue}${suffixText}`

  if (targetElement.tagName === 'TITLE' && (targetBinding === 'text' || targetBinding === 'value')) {
    targetElement.textContent = prefixedValue
    if (typeof document !== 'undefined') document.title = prefixedValue
    return
  }

  if (targetBinding === 'text') {
    targetElement.textContent = prefixedValue
  } else if (targetBinding === 'html') {
    targetElement.innerHTML = prefixedValue
  } else if (targetBinding === 'value') {
    targetElement.value = prefixedValue
  } else if (targetBinding.startsWith('attr:')) {
    const attributeName = targetBinding.slice(5)
    if (rawValue === null || rawValue === undefined) targetElement.removeAttribute(attributeName)
    else targetElement.setAttribute(attributeName, prefixedValue)
  } else if (targetBinding.startsWith('prop:')) {
    targetElement[targetBinding.slice(5)] = rawValue
  }
}

function replaceTemplateTokensInString(rawText, templateContext) {
  return rawText.replace(TEMPLATE_TOKEN_PATTERN, (_, pathExpression) => {
    const resolvedValue = resolveTemplateBindingValue(templateContext, pathExpression)
    return resolvedValue == null ? '' : String(resolvedValue)
  })
}

function applyTemplateBindingsToNode(rootNode, templateContext) {
  const nodesToProcess = []
  if (rootNode.nodeType === Node.ELEMENT_NODE) nodesToProcess.push(rootNode)
  rootNode.querySelectorAll?.('*')?.forEach((elementNode) => nodesToProcess.push(elementNode))

  for (const elementNode of nodesToProcess) {
    const conditionalPath = elementNode.getAttribute('data-qu-if')
    if (conditionalPath) {
      const shouldShowElement = Boolean(resolveTemplateBindingValue(templateContext, conditionalPath))
      elementNode.hidden = !shouldShowElement
    }

    const bindingPath = elementNode.getAttribute('data-qu-bind')
    if (bindingPath) {
      applyTemplateBindingValue(elementNode, resolveTemplateBindingValue(templateContext, bindingPath), {
        targetBinding: elementNode.getAttribute('data-qu-set') || 'text',
        formatName: elementNode.getAttribute('data-qu-format') || 'text',
        placeholderText: elementNode.getAttribute('data-qu-placeholder') || '–',
        prefixText: elementNode.getAttribute('data-qu-prefix') || '',
        suffixText: elementNode.getAttribute('data-qu-suffix') || '',
      })
    }

    for (const attributeName of elementNode.getAttributeNames()) {
      if (attributeName.startsWith('data-qu-')) continue
      const attributeValue = elementNode.getAttribute(attributeName)
      if (!attributeValue || !attributeValue.includes('{{')) continue
      elementNode.setAttribute(attributeName, replaceTemplateTokensInString(attributeValue, templateContext))
    }
  }

  const textWalker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT)
  let textNode = textWalker.nextNode()
  while (textNode) {
    if (textNode.textContent?.includes('{{')) {
      textNode.textContent = replaceTemplateTokensInString(textNode.textContent, templateContext)
    }
    textNode = textWalker.nextNode()
  }
}

function renderTemplateIntoElement(targetElement, templateElement, templateContext) {
  const templateFragment = templateElement.content.cloneNode(true)
  applyTemplateBindingsToNode(templateFragment, templateContext)
  targetElement.replaceChildren(templateFragment)
}

function extractValueFromDataRecord(sourceRecord, valuePath = 'val') {
  if (sourceRecord == null) return null
  if (valuePath === 'val' || valuePath === 'data') return sourceRecord?.data ?? sourceRecord
  if (valuePath.startsWith('^')) return sourceRecord?.[valuePath.slice(1)]
  if (QUBIT_ROOT_FIELD_NAMES.has(valuePath)) return sourceRecord?.[valuePath]
  return readNestedValue(sourceRecord?.data ?? sourceRecord, valuePath)
}

function cloneSerializableValue(sourceValue) {
  if (sourceValue == null) return sourceValue
  if (typeof structuredClone === 'function') return structuredClone(sourceValue)
  return JSON.parse(JSON.stringify(sourceValue))
}

export {
  QUBIT_ROOT_FIELD_NAMES,
  TEMPLATE_TOKEN_PATTERN,
  findInlineTemplateElement,
  cloneInlineTemplateElement,
  formatBindingValue,
  readNestedValue,
  writeNestedValue,
  createTemplateBindingContext,
  resolveTemplateBindingValue,
  applyTemplateBindingValue,
  replaceTemplateTokensInString,
  applyTemplateBindingsToNode,
  renderTemplateIntoElement,
  extractValueFromDataRecord,
  cloneSerializableValue,
}
