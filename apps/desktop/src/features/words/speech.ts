// 生词发音：Web Speech 本地语音（Windows 系统语音，不联网），无语音环境静默跳过
// voices 列表异步就绪，每次点击现取而非缓存；en 语音缺失时退回浏览器默认发音
export function speak(text: string): void {
  if (!('speechSynthesis' in window)) return
  try {
    const synth = window.speechSynthesis
    const voices = synth.getVoices()
    const voice =
      voices.find((v) => /^en/i.test(v.lang) && v.localService) ??
      voices.find((v) => /^en/i.test(v.lang)) ??
      null
    synth.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    if (voice) utter.voice = voice
    utter.lang = voice?.lang ?? 'en-US'
    utter.rate = 0.95
    synth.speak(utter)
  } catch {
    /* 无语音环境静默 */
  }
}
