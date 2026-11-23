import type { Db } from '../database.js';
import type { FormatoRelatorio, Prisma, TarefaRelatorio } from '../generated/prisma/client.js';
import { ErroNaoEncontrado } from '../domain/erros.js';

/** Tarefas de relatório assíncrono: o banco é a fonte da verdade do estado. */
export class TarefaRepository {
  constructor(private readonly db: Db) {}

  criar(dados: {
    organizacaoId: string;
    parceiroId: string | null;
    solicitante: string;
    tipo: string;
    formato: FormatoRelatorio;
    webhookUrl: string | null;
    maxTentativas: number;
  }): Promise<TarefaRelatorio> {
    return this.db.tarefaRelatorio.create({ data: dados });
  }

  buscar(id: string): Promise<TarefaRelatorio | null> {
    return this.db.tarefaRelatorio.findUnique({ where: { id } });
  }

  /** Busca restrita ao escopo de quem consulta (parceiro ou organização). */
  async buscarNoEscopoOuFalhar(id: string, escopo: { parceiroId?: string }): Promise<TarefaRelatorio> {
    const tarefa = await this.db.tarefaRelatorio.findFirst({
      where: { id, ...(escopo.parceiroId ? { parceiroId: escopo.parceiroId } : {}) },
    });
    if (!tarefa) throw new ErroNaoEncontrado('Tarefa de relatório', id);
    return tarefa;
  }

  atualizar(id: string, dados: Prisma.TarefaRelatorioUpdateInput): Promise<TarefaRelatorio> {
    return this.db.tarefaRelatorio.update({ where: { id }, data: dados });
  }

  listarInterrompidas(): Promise<{ id: string }[]> {
    return this.db.tarefaRelatorio.findMany({
      where: { status: { in: ['PENDENTE', 'PROCESSANDO'] } },
      select: { id: true },
    });
  }

  listarExpiradasComArquivo(agora: Date): Promise<{ id: string; arquivo: string | null }[]> {
    return this.db.tarefaRelatorio.findMany({
      where: { expiraEm: { lt: agora }, arquivo: { not: null } },
      select: { id: true, arquivo: true },
    });
  }
}
