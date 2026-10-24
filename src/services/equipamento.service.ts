import type {
  EstadoFisico,
  StatusRastreamento,
  TipoEquipamento,
} from '../generated/prisma/client.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { ErroNaoEncontrado } from '../domain/erros.js';
import { quedaDeCategorias } from '../domain/equipamento.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';
import { equipamentoDTO, equipamentoParaDominio, rastreioDTO } from './dto.js';

export class EquipamentoService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /** Histórico completo: equipamento + lote + organização + movimentações. */
  async rastrear(ator: Ator, idOuCodigo: string) {
    exigirPermissao(ator, 'equipamento:ler');
    const registro = await this.uow.leitura.equipamentos.rastrear(idOuCodigo);
    if (!registro) throw new ErroNaoEncontrado('Equipamento', idOuCodigo);
    return rastreioDTO(registro);
  }

  async listar(
    ator: Ator,
    filtro: { status?: StatusRastreamento; tipo?: TipoEquipamento; loteId?: string },
  ) {
    exigirPermissao(ator, 'equipamento:ler');
    return (await this.uow.leitura.equipamentos.listar(filtro)).map(equipamentoDTO);
  }

  /** Atualização de status + registro da movimentação: atômicos. */
  async atualizarStatus(
    ator: Ator,
    id: string,
    versao: number,
    novoStatus: StatusRastreamento,
    justificativa?: string,
  ) {
    exigirPermissao(ator, 'equipamento:escrever');

    return this.uow.emTransacao(async (repos) => {
      const registro = await repos.equipamentos.buscarComLoteOuFalhar(id);
      const equipamento = equipamentoParaDominio(registro);
      const transicao = equipamento.atualizarStatus(novoStatus, justificativa, registro.lote.statusProcessamento);

      await repos.equipamentos.atualizar(id, versao, { statusRastreamento: transicao.destino });
      await repos.historico.registrarMovimentacao({
        equipamentoId: id,
        origem: transicao.origem,
        destino: transicao.destino,
        responsavel: ator.usuario,
        observacao: justificativa?.trim() || null,
      });
      await repos.historico.registrarJournal({
        operacao: 'ALTERAR_STATUS',
        entidade: 'Equipamento',
        entidadeId: id,
        dadosAntes: { statusRastreamento: transicao.origem },
        dadosDepois: { statusRastreamento: transicao.destino, justificativa },
        usuarioResponsavel: ator.usuario,
      });
      return equipamentoDTO(await repos.equipamentos.buscarComLoteOuFalhar(id));
    });
  }

  async atualizarEstadoFisico(
    ator: Ator,
    id: string,
    versao: number,
    novoEstado: EstadoFisico,
    justificativa?: string,
  ) {
    exigirPermissao(ator, 'equipamento:escrever');

    return this.uow.emTransacao(async (repos) => {
      const registro = await repos.equipamentos.buscarComLoteOuFalhar(id);
      const equipamento = equipamentoParaDominio(registro);
      const anterior = equipamento.estadoFisico;
      equipamento.alterarEstadoFisico(novoEstado, justificativa);

      await repos.equipamentos.atualizar(id, versao, { estadoFisico: novoEstado });
      await repos.historico.registrarJournal({
        operacao: 'ALTERAR_ESTADO_FISICO',
        entidade: 'Equipamento',
        entidadeId: id,
        dadosAntes: { estadoFisico: anterior },
        dadosDepois: {
          estadoFisico: novoEstado,
          quedaDeCategorias: quedaDeCategorias(anterior, novoEstado),
          justificativa,
        },
        usuarioResponsavel: ator.usuario,
      });
      return equipamentoDTO(await repos.equipamentos.buscarComLoteOuFalhar(id));
    });
  }
}
