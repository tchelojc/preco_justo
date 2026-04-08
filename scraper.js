const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');

if (!fs.existsSync(DIR_CACHE)) fs.mkdirSync(DIR_CACHE, { recursive: true });

// Função para extrair preço de texto (ex: "R$ 29,90")
function extrairPreco(texto) {
  if (!texto) return null;
  const match = texto.replace(/[^\d,.-]/g, '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[0]) : null;
}

// Função para calcular preço por kg/L (simplificada)
function calcularPrecoUnidade(preco, nome, embalagemAlvo) {
  // Tenta extrair quantidade do nome (ex: "5kg", "1L")
  const match = nome.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|litro)/i);
  if (match) {
    let qtd = parseFloat(match[1]);
    const unidade = match[2].toLowerCase();
    if (unidade === 'g' || unidade === 'ml') qtd /= 1000;
    return preco / qtd;
  }
  // Fallback: usa embalagem do produto base
  if (embalagemAlvo) {
    const matchEmb = embalagemAlvo.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)/i);
    if (matchEmb) {
      let qtd = parseFloat(matchEmb[1]);
      const unidade = matchEmb[2].toLowerCase();
      if (unidade === 'g' || unidade === 'ml') qtd /= 1000;
      return preco / qtd;
    }
  }
  return preco; // fallback
}

async function main() {
  console.log('🚀 Iniciando scraper melhorado...\n');

  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));

  const mercadosAtivos = mercados.filter(m => m.ativo);
  console.log(`📋 ${mercadosAtivos.length} mercados ativos`);

  const indice = {
    data_geracao: new Date().toISOString(),
    mercados: mercadosAtivos.map(m => m.id),
    produtos: produtos.map(p => p.id),
    total_arquivos: 0
  };

  let arquivosGerados = 0;

  for (const mercado of mercadosAtivos) {
    console.log(`\n🏬 ${mercado.nome} (${mercado.plataforma})`);

    for (const produto of produtos.slice(0, 5)) { // ⚠️ Remova o slice depois
      const termo = produto.palavras_chave[0];
      let urlBusca = `${mercado.base_url}${mercado.busca_url_template.replace('{TERMO}', encodeURIComponent(termo))}`;

      // Ajustes específicos por plataforma
      if (mercado.plataforma === 'sitemercado') {
        urlBusca = `${mercado.base_url}/busca?q=${encodeURIComponent(termo)}`;
      }

      console.log(`   🔍 ${termo} → ${urlBusca}`);

      try {
        const response = await fetch(urlBusca, {
          headers: { 'User-Agent': USER_AGENT }
        });

        if (!response.ok) {
          console.log(`   ⚠️ HTTP ${response.status}`);
          continue;
        }

        const html = await response.text();
        const dom = new JSDOM(html);
        const doc = dom.window.document;

        let resultados = [];

        // ========== ESTRATÉGIA 1: JSON-LD ==========
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
          try {
            const data = JSON.parse(script.textContent);
            const items = data['@graph'] || (Array.isArray(data) ? data : [data]);

            for (const item of items) {
              if (item['@type'] === 'Product') {
                const nome = item.name;
                const oferta = item.offers;
                const preco = oferta?.price ? parseFloat(oferta.price) : null;

                if (preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p.toLowerCase()))) {
                  resultados.push({
                    nome,
                    preco,
                    preco_por_unidade: calcularPrecoUnidade(preco, nome, produto.embalagem),
                    gtin: item.gtin13 || item.gtin || '',
                    url: oferta?.url || item.url || urlBusca
                  });
                }
              }
            }
          } catch (e) {}
        }

        // ========== ESTRATÉGIA 2: SiteMercado (data-product-id) ==========
        if (resultados.length === 0 && mercado.plataforma === 'sitemercado') {
          const cards = doc.querySelectorAll('[data-product-id]');
          cards.forEach(card => {
            const nomeEl = card.querySelector('.product-title, .description, h3');
            const nome = nomeEl?.textContent?.trim();
            const precoEl = card.querySelector('.price, .product-price, .valor, .current-price');
            const preco = extrairPreco(precoEl?.textContent);

            if (nome && preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p.toLowerCase()))) {
              resultados.push({
                nome,
                preco,
                preco_por_unidade: calcularPrecoUnidade(preco, nome, produto.embalagem),
                url: card.querySelector('a')?.href || ''
              });
            }
          });
        }

        // ========== ESTRATÉGIA 3: VTEX ==========
        if (resultados.length === 0 && mercado.plataforma === 'vtex') {
          const cards = doc.querySelectorAll('.vtex-product-summary-2-x-container, [data-testid="product-card"]');
          cards.forEach(card => {
            const nomeEl = card.querySelector('.vtex-product-summary-2-x-productBrand, .product-title, h2');
            const nome = nomeEl?.textContent?.trim();
            const precoEl = card.querySelector('.vtex-product-price-1-x-sellingPrice, .price, .product-price');
            const preco = extrairPreco(precoEl?.textContent);

            if (nome && preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p.toLowerCase()))) {
              resultados.push({
                nome,
                preco,
                preco_por_unidade: calcularPrecoUnidade(preco, nome, produto.embalagem),
                url: card.querySelector('a')?.href || ''
              });
            }
          });
        }

        // ========== FALLBACK GENÉRICO ==========
        if (resultados.length === 0) {
          const elementos = doc.querySelectorAll(mercado.container_produto);
          elementos.forEach(el => {
            const nome = el.querySelector('h2, h3, .name, .product-name')?.textContent?.trim();
            const precoTexto = el.querySelector('.price, .product-price, .valor, [class*="price"]')?.textContent;
            const preco = extrairPreco(precoTexto);
            if (nome && preco && produto.palavras_chave.some(p => nome.toLowerCase().includes(p.toLowerCase()))) {
              resultados.push({
                nome,
                preco,
                preco_por_unidade: calcularPrecoUnidade(preco, nome, produto.embalagem),
                url: el.querySelector('a')?.href || ''
              });
            }
          });
        }

        // Salva cache
        const cacheFile = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);
        const cacheData = {
          data_hora: new Date().toISOString(),
          mercado_id: mercado.id,
          mercado_nome: mercado.nome,
          mercado_logo: mercado.logo,
          mercado_cor: mercado.cor,
          produto_id: produto.id,
          resultados: resultados.slice(0, 3)
        };

        fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
        arquivosGerados++;
        console.log(`   ✅ ${resultados.length} resultados`);

        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.log(`   ❌ Erro: ${err.message}`);
      }
    }
  }

  indice.total_arquivos = arquivosGerados;
  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify(indice, null, 2));
  console.log(`\n✨ Finalizado! ${arquivosGerados} arquivos gerados.`);
}

main().catch(err => { console.error('💥 Erro fatal:', err); process.exit(1); });
