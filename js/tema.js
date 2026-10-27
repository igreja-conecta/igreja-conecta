// Tema escolhido neste aparelho (claro ou escuro), aplicado antes de a página aparecer, para
// não piscar. Sem escolha, o app segue o tema do celular. A troca fica no botão do topo (js/app.js).
(function () {
  try {
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'escuro') document.documentElement.setAttribute('data-theme', t === 'escuro' ? 'dark' : 'light');
  } catch (e) {}
})();
