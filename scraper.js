const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR_DADOS = path.join(__dirname, 'dados');
const DIR_CACHE = path.join(DIR_DADOS, 'precos_cache');
if (!fs.existsSync(DIR_CACHE)) fs.mkdirSync(DIR_CACHE, { recursive: true });

// ========== UTILITÁRIOS ==========
function normalizarPreco(texto) {
  if (!texto) return null;
  const limpo = texto.replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = parseFloat(limpo);
  return isNaN(num) || num <= 0 ? null : num;
}

function calcularPrecoUnidade(preco, nome, embalagem) {
  const padroes = [
    { regex: /(\d+(?:[.,]\d+)?)\s*kg/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*g\b/i, mult: 0.001 },
    { regex: /(\d+(?:[.,]\d+)?)\s*l\b/i, mult: 1 },
    { regex: /(\d+(?:[.,]\d+)?)\s*ml/i, mult: 0.001 },
  ];
  for (const { regex, mult } of padroes) {
    const m = (nome + ' ' + embalagem).match(regex);
    if (m) {
      const qtd = parseFloat(m[1].replace(',', '.')) * mult;
      if (qtd > 0) return +(preco / qtd).toFixed(2);
    }
  }
  return null;
}

function normalizarTexto(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function bateProduto(nomeSite, palavrasChave) {
  const nomeNorm = normalizarTexto(nomeSite);
  return palavrasChave.some(p => nomeNorm.includes(normalizarTexto(p)));
}

// ========== EXTRAÇÃO ROBUSTA ==========
async function extrairItensDaPagina(page, categoria) {
  const seletoresAlternativos = {
    item: [categoria.seletores.item, '.product', '[class*="product"]', 'li', 'article'],
    nome: [categoria.seletores.nome, '.name', '[class*="title"]', 'h2', 'h3', 'a'],
    preco: [categoria.seletores.preco, '.price', '[class*="price"]', '.valor', 'strong', 'span'],
    link: [categoria.seletores.link, 'a', '[href*="/p/"]', '[href*="/produto/"]'],
  };

  // Tenta cada combinação de seletores até encontrar itens
  for (const itemSel of seletoresAlternativos.item) {
    try {
      await page.waitForSelector(itemSel, { timeout: 5000 }).catch(() => {});
      
      const itens = await page.$$eval(itemSel, (elements, selNomeList, selPrecoList, selLinkList) => {
        return elements.map(el => {
          // Tenta extrair nome
          let nome = '';
          for (const sel of selNomeList) {
            nome = el.querySelector(sel)?.innerText?.trim() || '';
            if (nome) break;
          }
          
          // Tenta extrair preço
          let preco = '';
          for (const sel of selPrecoList) {
            preco = el.querySelector(sel)?.innerText?.trim() || '';
            if (preco) break;
          }
          
          // Tenta extrair link
          let link = '';
          for (const sel of selLinkList) {
            const anchor = el.querySelector(sel);
            link = anchor?.href || '';
            if (link) break;
          }
          
          return { nome, preco, link };
        }).filter(item => item.nome && item.preco);
      }, seletoresAlternativos.nome, seletoresAlternativos.preco, seletoresAlternativos.link);
      
      if (itens.length > 0) return itens;
    } catch (e) {
      // Continua tentando próximo seletor
    }
  }
  
  return [];
}

// ========== MAIN ==========
async function main() {
  console.log('🚀 Iniciando scraper por categorias...\n');

  const mercados = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'mercados_rj.json'), 'utf8'));
  const produtos = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, 'produtos_base.json'), 'utf8'));
  const ativos = mercados.filter(m => m.ativo && m.tipo === 'pagina_categoria');

  console.log(`📋 Mercados ativos: ${ativos.map(m => m.nome).join(', ')}`);
  console.log(`📦 Produtos no catálogo: ${produtos.length}\n`);

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  let arquivosGerados = 0;

  for (const mercado of ativos) {
    console.log(`\n🏬 ${mercado.nome}`);
    const page = await context.newPage();

    const resultadosPorProduto = {};
    for (const produto of produtos) {
      resultadosPorProduto[produto.id] = [];
    }

    for (const categoria of mercado.categorias) {
      console.log(`   📂 Categoria: ${categoria.nome}`);
      console.log(`      🔗 URL: ${categoria.url}`);
      
      try {
        await page.goto(categoria.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        
        const itens = await extrairItensDaPagina(page, categoria);
        console.log(`      📊 ${itens.length} itens encontrados`);

        for (const item of itens) {
          const precoNum = normalizarPreco(item.preco);
          if (!precoNum) continue;

          for (const produto of produtos) {
            if (bateProduto(item.nome, produto.palavras_chave)) {
              resultadosPorProduto[produto.id].push({
                nome: item.nome.substring(0, 100),
                preco: precoNum,
                preco_por_unidade: calcularPrecoUnidade(precoNum, item.nome, produto.embalagem),
                url: item.link || categoria.url,
              });
              break;
            }
          }
        }

        // Log de produtos encontrados
        const produtosEncontrados = Object.entries(resultadosPorProduto)
          .filter(([_, arr]) => arr.length > 0)
          .map(([id]) => produtos.find(p => p.id === id)?.nome_canonico);
        
        if (produtosEncontrados.length > 0) {
          console.log(`      🛒 Produtos: ${produtosEncontrados.join(', ')}`);
        }
      } catch (err) {
        console.log(`      ❌ Erro: ${err.message}`);
      }
      
      await page.waitForTimeout(2000);
    }

    // Salva resultados
    for (const produto of produtos) {
      const resultados = resultadosPorProduto[produto.id] || [];
      const cacheFile = path.join(DIR_CACHE, `${mercado.id}_${produto.id}.json`);

      fs.writeFileSync(cacheFile, JSON.stringify({
        data_hora: new Date().toISOString(),
        mercado_id: mercado.id,
        mercado_nome: mercado.nome,
        mercado_logo: mercado.logo,
        mercado_cor: mercado.cor,
        produto_id: produto.id,
        resultados: resultados.slice(0, 5),
      }, null, 2));

      if (resultados.length > 0) {
        console.log(`   ✅ ${produto.nome_canonico}: ${resultados.length} opções`);
      }
      arquivosGerados++;
    }

    await page.close();
  }

  await browser.close();

  fs.writeFileSync(path.join(DIR_CACHE, '_indice.json'), JSON.stringify({
    atualizado_em: new Date().toISOString(),
    mercados: ativos.map(m => m.id),
    produtos: produtos.map(p => p.id),
    total_arquivos: arquivosGerados,
  }, null, 2));

  console.log(`\n✨ Concluído! ${arquivosGerados} arquivos gerados.`);
}

main().catch(err => { 
  console.error('💥 Erro fatal:', err.message);
  console.error(err.stack);
  process.exit(1); 
});
