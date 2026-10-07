export const Fragment = 'Fragment'
export const h = (tag, props, ...children) => `<${tag}>${children.join('')}</${tag}>`
