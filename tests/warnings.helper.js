// `fn()`'s result and what it warned (console.warn's arguments, space-joined), console.warn restored after.
export const captureWarnings = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

// The same for an async `fn`: console.warn is restored once it settles.
export const captureWarningsAsync = async (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: await fn(), warnings }
  } finally {
    console.warn = original
  }
}
