let n = 0
export const createUserMessage = input => Object.freeze({ ...input, id: `msg${++n}`, role: 'user' })
