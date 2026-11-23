import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Arquivos dos relatórios gerados. Caminhos montados só com `path`, então o
 * mesmo código funciona no Windows e no Linux.
 */
export class Armazenamento {
  constructor(private readonly diretorio: string) {}

  caminho(nomeArquivo: string): string {
    const destino = path.resolve(this.diretorio, nomeArquivo);
    // Impede que um nome manipulado aponte para fora do diretório de relatórios
    if (path.dirname(destino) !== path.resolve(this.diretorio)) throw new Error('Nome de arquivo inválido');
    return destino;
  }

  /**
   * Escreve em `<nome>.parcial` e só renomeia no final: um download nunca
   * recebe arquivo pela metade (mesmo princípio da escrita atômica do CLI).
   */
  async criarEscrita(nomeArquivo: string) {
    await mkdir(this.diretorio, { recursive: true });
    const final = this.caminho(nomeArquivo);
    const temporario = `${final}.parcial`;
    const fluxo = createWriteStream(temporario, { encoding: 'utf8' });

    return {
      escrever: (texto: string) =>
        new Promise<void>((resolve, reject) => {
          if (fluxo.write(texto)) return resolve();
          fluxo.once('drain', resolve);
          fluxo.once('error', reject);
        }),
      concluir: async () => {
        await new Promise<void>((resolve, reject) => fluxo.end((erro?: Error | null) => (erro ? reject(erro) : resolve())));
        await rename(temporario, final);
        return (await stat(final)).size;
      },
      descartar: async () => {
        fluxo.destroy();
        await rm(temporario, { force: true });
      },
    };
  }

  abrirLeitura(nomeArquivo: string) {
    return createReadStream(this.caminho(nomeArquivo));
  }

  async existe(nomeArquivo: string): Promise<boolean> {
    try {
      await access(this.caminho(nomeArquivo));
      return true;
    } catch {
      return false;
    }
  }

  async remover(nomeArquivo: string): Promise<void> {
    await rm(this.caminho(nomeArquivo), { force: true });
  }
}
