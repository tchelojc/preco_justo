/**
 * =============================================================
 * COMPARADOR RJ — Scraper v2 (API-First)
 * Usa APIs JSON públicas dos sites. Sem browser, sem JSDOM.
 * Compatível com Node.js 20+ (CommonJS para evitar conflitos)
 * =============================================================
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');

if (!fs.existsSync(DIR_CACHE)) fs.mkdirSync(DIR_CACHE, { recursive: true });

const HEADERS_PADRAO = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer':         'https://www.google.com.br/',
};

// ─── Utilitário: fetch simples com timeout ────────────────────
function fetchJSON(url, headersExtras = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const hdrs  = { ...HEADERS_PADRAO, ...headersExtras };
    const proto = url.startsWith('https') ? https : http;
    const u     = new URL(url);

    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  hdrs,
      timeout:  timeoutMs,
    };

    const req = proto.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Segue redirect uma vez
        return fetchJSON(res.headers.location, headersExtras, timeoutMs)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const texto = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(texto));
        } catch (e) {
          reject(new Error(`JSON inválido: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error',   reject);
    req.end();
  });
}

// ─── Utilitários de normalização ─────────────────────────────

function normalizarPreco(valor) {
  if (valor == null) return null;
  const n = parseFloat(String(valor).replace(',', '.'));
  return isNaN(n) || n <= 0 ? null : +n.toFixed(2);
}

function calcularPrecoPorUnidade(nome, preco, embalagemProduto) {
  // Tenta extrair do nome do produto
  const padroes = [
    { r: /(\d+(?:[.,]\d+)?)\s*kg/i,  m: 1      },
    { r: /(\d+(?:[.,]\d+)?)\s*g\b/i, m: 0.001  },
    { r: /(\d+(?:[.,]\d+)?)\s*l\b(?!b)/i, m: 1 },
    { r: /(\d+(?:[.,]\d+)?)\s*litros?/i,  m: 1 },
    { r: /(\d+(?:[.,]\d+)?)\s*ml/i,  m: 0.001  },
  ];
  for (const { r, m } of padroes) {
    const match = nome.match(r);
    if (match) {
      const qtd = parseFloat(match[1].replace(',', '.')) * m;
      if (qtd > 0) return +(preco / qtd).toFixed(2);
    }
  }
  // Fallback: usa embalagem do produto base
  if (embalagemProduto) {
    for (const { r, m } of padroes) {
      const match = embalagemProduto.match(r);
      if (match) {
        const qtd = parseFloat(match[1].replace(',', '.')) * m;
        if (qtd > 0) return +(preco / qtd).toFixed(2);
      }
    }
  }
  return null;
}

function normalizar(txt) {
  return (txt || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function bate(nomeSite, palavrasChave) {
  const n = normalizar(nomeSite);
  return palavrasChave.some(p => n.includes(normalizar(p)));
}

// ─── Estratégias por plataforma ───────────────────────────────

/**
 * VTEX: API pública de busca de produtos
 * Funciona para: Guanabara, Pão de Açúcar, Atacadão, Prezunic
 */
async function rasparVTEX(mercado, produto) {
  const termo = produto.palavras_chave[0];
  const url   = `${mercado.base_url}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=9`;

  const dados = await fetchJSON(url, {
    'Referer':  mercado.base_url + '/',
    'Origin':   mercado.base_url,
  });

  if (!Array.isArray(dados)) return [];

  const resultados = [];
  for (const prod of dados) {
    const nome = prod.productName || prod.productTitle || '';
    if (!bate(nome, produto.palavras_chave)) continue;

    for (const item of prod.items || []) {
      const seller = item.sellers?.[0];
      const oferta = seller?.commertialOffer;
      if (!oferta) continue;

      const preco = normalizarPreco(oferta.Price || oferta.ListPrice);
      if (!preco) continue;

      const gtin = item.ean || item.referenceId?.[0]?.Value || '';
      const url_prod = `${mercado.base_url}/${prod.linkText}/p` ;

      resultados.push({
        nome,
        preco,
        preco_por_unidade: calcularPrecoPorUnidade(nome, preco, produto.embalagem),
        gtin,
        url: url_prod,
      });

      break; // só o primeiro item/seller por produto
    }
  }

  return resultados.slice(0, 5);
}

/**
 * SiteMercado: API REST pública
 * Funciona para: Mundial, Super Market, Super Compras, Vianense
 */
async function rasparSiteMercado(mercado, produto) {
  const termo = produto.palavras_chave[0];

  // A URL de slug varia por mercado. Extraímos da base_url
  const slugMatch = mercado.base_url.match(/sitemercado\.com\.br\/([^/]+)/);
  const slug = slugMatch ? slugMatch[1] : '';

  const url = `https://www.sitemercado.com.br/api/product/search?search=${encodeURIComponent(termo)}&loja=${slug}&limit=10`;

  let dados;
  try {
    dados = await fetchJSON(url, { 'Referer': 'https://www.sitemercado.com.br/' });
  } catch (_) {
    // Tenta endpoint alternativo
    const url2 = `https://www.sitemercado.com.br/api/1.0/loja/${slug}/produtos/?palavra=${encodeURIComponent(termo)}&limite=10`;
    dados = await fetchJSON(url2, { 'Referer': 'https://www.sitemercado.com.br/' });
  }

  // SiteMercado pode retornar array diretamente ou {produtos: [...]}
  const lista = Array.isArray(dados)
    ? dados
    : dados?.produtos || dados?.data || dados?.items || [];

  const resultados = [];
  for (const prod of lista) {
    const nome  = prod.nome || prod.descricao || prod.name || prod.title || '';
    if (!bate(nome, produto.palavras_chave)) continue;

    const preco = normalizarPreco(prod.preco || prod.price || prod.preco_promo || prod.valor);
    if (!preco) continue;

    resultados.push({
      nome,
      preco,
      preco_por_unidade: calcularPrecoPorUnidade(nome, preco, produto.embalagem),
      gtin: prod.ean || prod.gtin || prod.barcode || '',
      url:  prod.link || prod.url || `${mercado.base_url}/busca?q=${encodeURIComponent(nome)}`,
    });
  }

  return resultados.slice(0, 5);
}

/**
 * Hortifruti: site próprio, tenta API interna
 */
async function rasparHortifruti(mercado, produto) {
  const termo = produto.palavras_chave[0];
  const url   = `https://www.hortifruti.com.br/api/products/search?q=${encodeURIComponent(termo)}&limit=10`;

  const dados = await fetchJSON(url, { 'Referer': 'https://www.hortifruti.com.br/' });
  const lista = Array.isArray(dados)
    ? dados
    : dados?.products || dados?.data || dados?.items || [];

  const resultados = [];
  for (const prod of lista) {
    const nome  = prod.name || prod.title || prod.description || '';
    if (!bate(nome, produto.palavras_chave)) continue;

    const preco = normalizarPreco(prod.price || prod.preco || prod.valor);
    if (!preco) continue;

    resultados.push({
      nome,
      preco,
      preco_por_unidade: calcularPrecoPorUnidade(nome, preco, produto.embalagem),
      gtin: prod.ean || '',
      url:  prod.url || `https://www.hortifruti.com.br/busca?q=${encodeURIComponent(termo)}`,
    });
  }

  return resultados.slice(0, 5);
}

// ─── Dispatcher: escolhe a estratégia certa ──────────────────

async function rasparMercadoProduto(mercado, produto) {
  switch (mercado.plataforma) {
    case 'vtex':       return rasparVTEX(mercado, produto);
    case 'sitemercado': return rasparSiteMercado(mercado, produto);
    case 'hortifruti': return rasparHortifruti(mercado, produto);
    default:
      // Tenta VTEX genérico como fallback
      try { return await rasparVTEX(mercado, produto); } catch (_) { return []; }
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Scraper v2 iniciado — ${new Date().toLocaleString('pt-BR')}\n`);

  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos  = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));

  const ativos = mercados.filter(m => m.ativo);
  console.log(`📋 ${ativos.length} mercados ativos, ${produtos.length} produtos\n`);

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

      // Salva mesmo vazio (o GAS ignora vazios ao comparar)
      const arquivo = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);
      fs.writeFileSync(arquivo, JSON.stringify({
        data_hora:        new Date().toISOString(),
        mercado_id:       mercado.id,
        mercado_nome:     mercado.nome,
        mercado_logo:     mercado.logo,
        mercado_cor:      mercado.cor,
        produto_id:       produto.id,
        produto_nome:     produto.nome_canonico,
        produto_categoria: produto.categoria,
        resultados,
      }, null, 2), 'utf8');

      arquivosGerados++;

      // Pausa educada (1–2s) para não levar ban
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }

  // Atualiza índice
  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify({
    atualizado_em:   new Date().toISOString(),
    mercados:        ativos.map(m => m.id),
    produtos:        produtos.map(p => p.id),
    total_arquivos:  arquivosGerados,
  }, null, 2), 'utf8');

  console.log(`\n✨ Concluído! ${arquivosGerados} arquivos gerados.\n`);
}

main().catch(err => {
  console.error('\n💥 Erro fatal:', err.message);
  process.exit(1);
});
