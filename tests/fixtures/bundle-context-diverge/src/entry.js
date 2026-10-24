console.log('require', require('dual'))
import('dual').then((m) => console.log('import', m.default))
