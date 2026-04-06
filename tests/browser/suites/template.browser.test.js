import { KEY } from '../../../src/core/qubit.js'
import { registerComponents } from '../../../src/ui/components.js'
import { createReadyIdentity, createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerTemplateBrowserSuite(registerSuite) {
  registerSuite('Template rendering', 'Generic native <template> support for qu-bind and qu-list', ({ test }) => {
    test('qu-bind renders a child template against the current QuBit context', async ({ assertEqual, waitFor }) => {
      const identity = await createReadyIdentity('Template Alice')
      const database = await createReadyMemoryDatabase(identity)
      registerComponents(database, { me: { pub: identity.pub }, peers: null, net: null })

      const messageKey = `@template-bind/messages/${KEY.ts16()}`
      const bindElement = document.createElement('qu-bind')
      bindElement.setAttribute('key', messageKey)
      bindElement.innerHTML = `
        <template>
          <article class="message-card" title="{{key}}">
            <strong data-qu-bind="text"></strong>
            <time data-qu-bind="ts" data-qu-format="time"></time>
          </article>
        </template>
      `
      document.body.appendChild(bindElement)

      await database.put(messageKey, { text: 'Rendered from a template' })

      await waitFor(() => {
        const titleElement = bindElement.querySelector('article.message-card')
        const textElement = bindElement.querySelector('strong')
        assertEqual(textElement?.textContent, 'Rendered from a template', 'template text binding')
        assertEqual(titleElement?.getAttribute('title'), messageKey, 'template attribute interpolation')
      })

      bindElement.remove()
    })

    test('qu-list renders each item through a native child template', async ({ assertDeepEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      registerComponents(database, { me: null, peers: null, net: null })

      const listPrefix = '@template-list/items/'
      const listElement = document.createElement('qu-list')
      listElement.setAttribute('prefix', listPrefix)
      listElement.innerHTML = `
        <template>
          <li class="template-row">
            <span class="title" data-qu-bind="text"></span>
            <span class="state" data-qu-bind="done" data-qu-format="bool"></span>
          </li>
        </template>
      `
      document.body.appendChild(listElement)

      await database.put(`${listPrefix}${KEY.ts16()}-a`, { text: 'Alpha', done: false })
      await database.put(`${listPrefix}${KEY.ts16()}-b`, { text: 'Beta', done: true })

      await waitFor(() => {
        const renderedTitles = [...listElement.querySelectorAll('.title')].map((element) => element.textContent)
        const renderedStates = [...listElement.querySelectorAll('.state')].map((element) => element.textContent)
        assertDeepEqual(renderedTitles, ['Alpha', 'Beta'], 'template list titles')
        assertDeepEqual(renderedStates, ['–', '✓'], 'template list state formatting')
      })

      listElement.remove()
    })
  })
}

export { registerTemplateBrowserSuite }
