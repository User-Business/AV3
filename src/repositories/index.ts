import type { Db } from '../database.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ContratoRepository } from './contrato.repository.js';
import { EquipamentoRepository } from './equipamento.repository.js';
import { HistoricoRepository } from './historico.repository.js';
import { LoteRepository } from './lote.repository.js';
import { OrganizacaoRepository } from './organizacao.repository.js';
import { UsuarioRepository } from './usuario.repository.js';

/** Conjunto de repositórios ligados a um mesmo cliente (raiz ou transação). */
export class Repositorios {
  readonly usuarios: UsuarioRepository;
  readonly organizacoes: OrganizacaoRepository;
  readonly contratos: ContratoRepository;
  readonly lotes: LoteRepository;
  readonly equipamentos: EquipamentoRepository;
  readonly historico: HistoricoRepository;

  constructor(db: Db) {
    this.usuarios = new UsuarioRepository(db);
    this.organizacoes = new OrganizacaoRepository(db);
    this.contratos = new ContratoRepository(db);
    this.lotes = new LoteRepository(db);
    this.equipamentos = new EquipamentoRepository(db);
    this.historico = new HistoricoRepository(db);
  }
}

/**
 * Unit of Work: o SERVIÇO decide a fronteira da transação; os repositórios só
 * executam. Tudo o que roda dentro de `emTransacao` é confirmado junto ou
 * desfeito junto ($transaction interativa do Prisma).
 */
export class UnidadeDeTrabalho {
  readonly leitura: Repositorios;

  constructor(private readonly prisma: PrismaClient) {
    this.leitura = new Repositorios(prisma);
  }

  emTransacao<T>(operacao: (repos: Repositorios) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => operacao(new Repositorios(tx)), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  }
}
