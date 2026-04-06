import { KEY } from '../../../src/core/qubit.js'
import { registerComponents } from '../../../src/ui/components.js'
import { createReadyIdentity, createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerNativeBindingBrowserSuite(registerSuite) {
  registerSuite('Native qu-* bindings', 'Plain HTML elements can bind directly without wrapper containers', ({ test }) => {
    test('inline span binding shows and updates the current user alias reactively', async ({ assertEqual, waitFor }) => {
      const identity = await createReadyIdentity('Inline Alias Alice')
      const database = await createReadyMemoryDatabase(identity)
      registerComponents(database, { me: { pub: identity.pub }, peers: null, net: null })

      const inlineAliasElement = document.createElement('span')
      inlineAliasElement.setAttribute('qu-key', '~/alias')
      document.body.appendChild(inlineAliasElement)

      await database.put(KEY.user(identity.pub).alias, 'Inline Alias Ready')

      await waitFor(() => {
        assertEqual(inlineAliasElement.textContent, 'Inline Alias Ready', 'reactive inline alias text')
      })

      inlineAliasElement.remove()
    })

    test('two-way input binding writes changed values back into QuDB', async ({ assertEqual, waitFor }) => {
      const identity = await createReadyIdentity('Native Two Way Alice')
      const database = await createReadyMemoryDatabase(identity)
      registerComponents(database, { me: { pub: identity.pub }, peers: null, net: null })

      const titleInputElement = document.createElement('input')
      titleInputElement.setAttribute('qu-key', 'conf/app/title')
      titleInputElement.setAttribute('qu-bind', 'value')
      titleInputElement.setAttribute('qu-mode', 'two-way')
      document.body.appendChild(titleInputElement)

      titleInputElement.value = 'Bound Title Value'
      titleInputElement.dispatchEvent(new Event('change', { bubbles: true }))

      await waitFor(async () => {
        const storedTitleQuBit = await database.get('conf/app/title')
        assertEqual(storedTitleQuBit?.data, 'Bound Title Value', 'stored two-way title value')
      })

      titleInputElement.remove()
    })

    test('head title binding keeps document.title reactive', async ({ assertEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      registerComponents(database, { me: null, peers: null, net: null })

      const titleElement = document.head.querySelector('title') ?? document.createElement('title')
      if (!titleElement.isConnected) document.head.appendChild(titleElement)
      titleElement.setAttribute('qu-key', 'conf/app/title')

      await database.put('conf/app/title', 'Reactive Browser Title')

      await waitFor(() => {
        assertEqual(document.title, 'Reactive Browser Title', 'document.title value')
        assertEqual(titleElement.textContent, 'Reactive Browser Title', 'title element text content')
      })

      titleElement.removeAttribute('qu-key')
    })

    test('removed native binding elements clean up their database listeners automatically', async ({ assertEqual, waitFor }) => {
      const identity = await createReadyIdentity('Cleanup Alice')
      const database = await createReadyMemoryDatabase(identity)
      const bindingRuntime = registerComponents(database, { me: { pub: identity.pub }, peers: null, net: null })

      const transientAliasElement = document.createElement('span')
      transientAliasElement.setAttribute('qu-key', '~/alias')
      document.body.appendChild(transientAliasElement)

      await waitFor(() => {
        assertEqual(bindingRuntime.getStats().nativeBindingCount, 1, 'binding count after mount')
      })

      transientAliasElement.remove()

      await waitFor(() => {
        assertEqual(bindingRuntime.getStats().nativeBindingCount, 0, 'binding count after removal')
      })
    })

    test('an inline counter inside a sentence updates reactively without changing layout semantics', async ({ assertEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      registerComponents(database, { me: null, peers: null, net: null })

      const paragraphElement = document.createElement('p')
      paragraphElement.innerHTML = 'You have <span qu-key="conf/app/unread" qu-format="count"></span> unread items.'
      document.body.appendChild(paragraphElement)

      await database.put('conf/app/unread', 7)

      await waitFor(() => {
        assertEqual(paragraphElement.textContent.trim(), 'You have 7 unread items.', 'reactive inline counter text')
      })

      paragraphElement.remove()
    })

    test('attribute bindings can drive native tooltip attributes reactively', async ({ assertEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      registerComponents(database, { me: null, peers: null, net: null })

      const tooltipTargetElement = document.createElement('span')
      tooltipTargetElement.textContent = 'Hover me'
      tooltipTargetElement.setAttribute('qu-key', 'conf/app/title')
      tooltipTargetElement.setAttribute('qu-bind', 'attr:title')
      document.body.appendChild(tooltipTargetElement)

      await database.put('conf/app/title', 'Tooltip Title')

      await waitFor(() => {
        assertEqual(tooltipTargetElement.getAttribute('title'), 'Tooltip Title', 'reactive tooltip attribute')
      })

      tooltipTargetElement.remove()
    })
  })
}

export { registerNativeBindingBrowserSuite }
