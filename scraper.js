const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');
if (!fs.existsSync(DIR_CACHE)) fs.mkdirSync(DIR_CACHE, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ========== FETCH GENÉRICO (texto ou JSON) ==========
function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json', ...headers },
      timeout: 10000,
    };
    const req = proto.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchJSON(url, headers = {}) {
  const text = await fetchText(url, { ...headers, 'Accept': 'application/json' });
  return JSON.parse(text);
}

// ========== NORMALIZAÇÃO ==========
function normalizarPreco(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : +n.toFixed(2);
}

function calcularPrecoUnidade(nome, preco, embalagemBase) {
  const padroes = [
    { regex: /(\d+(?:[.,]\d+)?)\s*kg/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*g\b/i, mult: 0.001 },
    { regex: /(\d+(?:[.,]\d+)?)\s*l\b/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*ml/i, mult: 0.001 },
  ];
  for (const { regex, mult } of padroes) {
    const m = nome.match(regex);
    if (m) {
      const qtd = parseFloat(m[1].replace(',', '.')) * mult;
      if (qtd > 0) return +(preco / qtd).toFixed(2);
    }
  }
  if (embalagemBase) {
    for (const { regex, mult } of padroes) {
      const m = embalagemBase.match(regex);
      if (m) {
        const qtd = parseFloat(m[1].replace(',', '.')) * mult;
        if (qtd > 0) return +(preco / qtd).toFixed(2);
      }
    }
  }
  return null;
}

function normalizarTexto(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function bate(nome, palavras) {
  const n = normalizarTexto(nome);
  return palavras.some(p => n.includes(normalizarTexto(p)));
}

// ========== EXTRAÇÃO DE JSON-LD DO HTML ==========
function extrairPrecosDoHTML(html, produto, baseUrl) {
  const resultados = [];
  // Procura por scripts JSON-LD
  const scriptRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = data['@graph'] || (Array.isArray(data) ? data : [data]);
      for (const item of items) {
        if (item['@type'] === 'Product') {
          const nome = item.name;
          if (!bate(nome, produto.palavras_chave)) continue;
          const oferta = item.offers;
          const preco = oferta?.price ? parseFloat(oferta.price) : null;
          if (!preco) continue;
          resultados.push({
            nome,
            preco,
            preco_por_unidade: calcularPrecoUnidade(nome, preco, produto.embalagem),
            gtin: item.gtin13 || item.gtin || '',
            url: oferta?.url || item.url || baseUrl,
          });
        }
      }
    } catch (e) {}
  }
  return resultados.slice(0, 5);
}

// ========== ESTRATÉGIAS POR PLATAFORMA ==========

async function rasparVTEX(mercado, produto) {
  const termo = produto.palavras_chave[0];
  // Tenta API primeiro
  try {
    const urlAPI = `${mercado.base_url}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=9`;
    const dados = await fetchJSON(urlAPI, { 'Referer': mercado.base_url });
    const resultados = [];
    for (const prod of dados) {
      const nome = prod.productName || '';
      if (!bate(nome, produto.palavras_chave)) continue;
      for (const item of prod.items || []) {
        const seller = item.sellers?.[0];
        const oferta = seller?.commertialOffer;
        if (!oferta) continue;
        const preco = normalizarPreco(oferta.Price);
        if (!preco) continue;
        resultados.push({
          nome,
          preco,
          preco_por_unidade: calcularPrecoUnidade(nome, preco, produto.embalagem),
          gtin: item.ean || '',
          url: `${mercado.base_url}/${prod.linkText}/p`,
        });
        break;
      }
    }
    if (resultados.length > 0) return resultados.slice(0, 5);
  } catch (e) {}

  // Fallback: scraping HTML da página de busca
  const urlBusca = `${mercado.base_url}/${encodeURIComponent(termo)}?_q=${encodeURIComponent(termo)}&map=ft`;
  const html = await fetchText(urlBusca, { 'Referer': mercado.base_url });
  return extrairPrecosDoHTML(html, produto, urlBusca);
}

async function rasparSiteMercado(mercado, produto) {
  const termo = produto.palavras_chave[0];
  const slug = mercado.base_url.split('/').pop();
  // API do SiteMercado (pode precisar de ID da loja)
  try {
    const urlAPI = `https://www.sitemercado.com.br/api/product/search?search=${encodeURIComponent(termo)}&loja=${slug}&limit=10`;
    const dados = await fetchJSON(urlAPI);
    const lista = Array.isArray(dados) ? dados : dados?.produtos || [];
    const resultados = [];
    for (const prod of lista) {
      const nome = prod.nome || prod.descricao || '';
      if (!bate(nome, produto.palavras_chave)) continue;
      const preco = normalizarPreco(prod.preco || prod.preco_promo);
      if (!preco) continue;
      resultados.push({
        nome,
        preco,
        preco_por_unidade: calcularPrecoUnidade(nome, preco, produto.embalagem),
        gtin: prod.ean || '',
        url: prod.link || `${mercado.base_url}/busca?q=${encodeURIComponent(termo)}`,
      });
    }
    if (resultados.length > 0) return resultados.slice(0, 5);
  } catch (e) {}

  // Fallback HTML
  const urlBusca = `${mercado.base_url}/busca?q=${encodeURIComponent(termo)}`;
  const html = await fetchText(urlBusca);
  return extrairPrecosDoHTML(html, produto, urlBusca);
}

// ========== NOVA FUNÇÃO PARA GUANABARA (BUSCA HTML) ==========
async function rasparGuanabara(mercado, produto) {
  const termo = produto.palavras_chave[0];
  const urlBusca = `${mercado.base_url}/busca?q=${encodeURIComponent(termo)}`;
  console.log(`   🌐 Buscando: ${urlBusca}`);

  let html;
  try {
    html = await fetchText(urlBusca, {
      'User-Agent': UA,
      'Accept': 'text/html',
      'Referer': mercado.base_url,
    });
  } catch (err) {
    console.log(`   ❌ Erro ao buscar HTML: ${err.message}`);
    return [];
  }

  // Expressão regular para capturar blocos de produto: 
  // Padrão: preço (R$ 12,34 ou 12,34) seguido de nome em linha(s) subsequente
  // Vamos usar uma regex que encontra um preço e captura o texto seguinte até o próximo preço ou fim.
  const precoRegex = /(?:R\$)?\s*(\d{1,3}(?:\.\d{3})*,\d{2})\s*/g;
  const linhas = html.split(/\r?\n/);
  const resultados = [];

  for (let i = 0; i < linhas.length; i++) {
    let linha = linhas[i];
    let match = precoRegex.exec(linha);
    if (match) {
      const precoStr = match[1].replace(/\./g, '').replace(',', '.');
      const preco = parseFloat(precoStr);
      if (isNaN(preco)) continue;

      // O nome do produto geralmente está na mesma linha ou na próxima linha
      let nome = '';
      // Se a linha atual tem texto após o preço, extrai
      let resto = linha.substring(match.index + match[0].length).trim();
      if (resto.length > 0) {
        nome = resto;
      } else if (i + 1 < linhas.length) {
        // Senão, pega a próxima linha
        nome = linhas[i + 1].trim();
        // Avança uma linha para não reprocessar o nome como preço
        i++;
      }

      // Limpa nome (remove tags HTML residuais)
      nome = nome.replace(/<[^>]*>/g, '').trim();
      if (nome.length === 0) continue;

      // Verifica se o nome corresponde às palavras-chave
      if (!bate(nome, produto.palavras_chave)) continue;

      resultados.push({
        nome,
        preco,
        preco_por_unidade: calcularPrecoUnidade(nome, preco, produto.embalagem),
        gtin: '',
        url: urlBusca, // ou poderia extrair link do produto, mas opcional
      });

      // Limita a 5 resultados por produto
      if (resultados.length >= 5) break;
    }
  }

  // Se não achou nada, tenta um fallback: busca por JSON-LD ou elementos comuns
  if (resultados.length === 0) {
    console.log(`   ⚠️ Nenhum resultado via regex, tentando extração por JSON-LD...`);
    return extrairPrecosDoHTML(html, produto, urlBusca);
  }

  return resultados;
}

async function rasparMercadoProduto(mercado, produto) {
  // Tratamento especial para Guanabara
  if (mercado.id === 'guanabara') {
    return rasparGuanabara(mercado, produto);
  }

  switch (mercado.plataforma) {
    case 'vtex': return rasparVTEX(mercado, produto);
    case 'sitemercado': return rasparSiteMercado(mercado, produto);
    case 'hortifruti': return rasparHortifruti(mercado, produto);
    default:
      try { return await rasparVTEX(mercado, produto); } catch (_) { return []; }
  }
}

// ========== MAIN ==========
async function main() {
  console.log(`\n🚀 Scraper v3 iniciado — ${new Date().toLocaleString('pt-BR')}\n`);

  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));
  const ativos = mercados.filter(m => m.ativo);

  console.log(`📋 ${ativos.length} mercados ativos, ${produtos.length} produtos`);

  let arquivosGerados = 0;

  for (const mercado of ativos) {
    console.log(`\n🏬 ${mercado.nome} [${mercado.plataforma}]`);

    for (const produto of produtos) {
      process.stdout.write(`   🔍 ${produto.nome_canonico} ... `);
      let resultados = [];
      try {
        resultados = await rasparMercadoProduto(mercado, produto);
        console.log(`✅ ${resultados.length} resultados`);
      } catch (err) {
        console.log(`❌ ${err.message}`);
      }

      const cacheFile = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);
      fs.writeFileSync(cacheFile, JSON.stringify({
        data_hora: new Date().toISOString(),
        mercado_id: mercado.id,
        mercado_nome: mercado.nome,
        mercado_logo: mercado.logo,
        mercado_cor: mercado.cor,
        produto_id: produto.id,
        resultados,
      }, null, 2));

      arquivosGerados++;
      await new Promise(r => setTimeout(r, 1500)); // delay educado
    }
  }

  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify({
    atualizado_em: new Date().toISOString(),
    mercados: ativos.map(m => m.id),
    produtos: produtos.map(p => p.id),
    total_arquivos: arquivosGerados,
  }, null, 2));

  console.log(`\n✨ Concluído! ${arquivosGerados} arquivos gerados.`);
}

main().catch(err => { console.error('💥 Erro fatal:', err); process.exit(1); });
